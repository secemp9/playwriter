import { parse } from '@babel/parser'
import type { ICDPSession } from './cdp-session.js'
import type { Protocol } from 'devtools-protocol'

export interface BreakpointInfo {
  id: string
  file: string
  line: number
  /** The condition, if any. A logpoint's condition is verified non-pausing. */
  condition?: string
  /** True when the condition was proven never to evaluate truthy (a logpoint). */
  nonPausing: boolean
  /**
   * Whether V8 actually BOUND the breakpoint to a location in a loaded script.
   *
   * `Debugger.setBreakpointByUrl` returns a `breakpointId` unconditionally — measured:
   * a URL no script has, and a line past the end of a real script, both come back with
   * an id and an EMPTY `locations` array. The id alone therefore proves nothing, and an
   * unbound logpoint that never fires reads exactly like a code path that never ran.
   */
  bound: boolean
  /** The script locations V8 resolved. Empty means `bound: false`. */
  resolvedLocations: Array<{ scriptId: string; url: string; lineNumber: number; columnNumber?: number }>
}

/**
 * Turn a file identifier into a `urlRegex` that matches THAT file and not its
 * neighbours.
 *
 * The previous form was a bare escaped string, which `Debugger.setBreakpointByUrl`
 * treats as an unanchored search — measured: `app.js` bound in BOTH `app.js` and
 * `vendor-app.js`, returning two locations, so a logpoint armed for one file also fired
 * in the other and its hits interleaved under one tag.
 *
 * The anchors are `(^|/)` … `([?#]|$)`: a bare filename still matches a full URL at a
 * path boundary (`https://host/app.js`), a full URL still matches from the start, a
 * cache-busting query (`app.js?v=2`) still matches, and `vendor-app.js` no longer does
 * because the character before `app.js` there is `-`, which is neither `/` nor the start
 * of the string.
 */
export function buildBreakpointUrlRegex(file: string): string {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `(^|/)${escaped}([?#]|$)`
}

export interface LocationInfo {
  url: string
  lineNumber: number
  columnNumber: number
  callstack: Array<{
    functionName: string
    url: string
    lineNumber: number
    columnNumber: number
  }>
  sourceContext: string
}

/**
 * What the expression threw. PRESENT ONLY when it threw, so a caller cannot read a
 * failed evaluation as a successful one — the whole point of this field's existence.
 */
export interface EvaluateThrow {
  /** `Error: boom` — the exception's own description, not a paraphrase. */
  message: string
  /** `Error`, `TypeError`, `ReferenceError`… Absent when the thrown value is not an object. */
  className?: string
  /** The stack V8 attached to the thrown value, when it carried one. */
  stack?: string
  /** V8's own summary line, e.g. `Uncaught`. */
  text: string
  /** 0-based, as CDP sends them; only meaningful for parse/compile failures. */
  lineNumber?: number
  columnNumber?: number
}

export interface EvaluateResult {
  /** The completion value. `undefined` when `threw` is set — read `threw` first. */
  value: unknown
  /**
   * Set ONLY when the expression threw. Its ABSENCE is the proof that `value` is a real
   * completion value.
   *
   * This exists because the old implementation wrapped every expression in
   * `try { … } catch (e) { e }` and asked for `returnByValue: true`. Under that flag V8
   * serialises an `Error` to `{}` — measured — so `evaluate({ expression: 'throw new
   * Error("boom")' })` returned `{ value: {} }`, byte-identical to evaluating `({})`.
   * A debugger that reports a thrown exception as an empty object confirms bugs that do
   * not exist and hides the one that does.
   */
  threw?: EvaluateThrow
}

export interface ScriptInfo {
  scriptId: string
  url: string
}

/** One resolved scope in a paused call frame, with its variables read eagerly. */
export interface ScopeVars {
  type: string
  variables: Record<string, unknown>
}

/**
 * A single paused call frame. Unlike `inspectLocalVariables` (TOP frame only)
 * this reads EVERY frame's local/closure scopes. Both keep values (large ones
 * capped, not dropped). Only valid while paused.
 */
export interface CallFrameInfo {
  functionName: string
  url: string
  location: { line: number; column: number }
  this?: unknown
  scopeChain: ScopeVars[]
  /** `"<path>: <reason>"` for every string capped in this frame. */
  cappedValues: string[]
  /** `"<path>: <reason>"` for every container the BROWSER cut short in this frame.
   *  Values keep their real shape; the accounting lives here instead. */
  overflowedContainers: string[]
}

/** Handle returned by `captureArgsAt` — the caller drains hits from the log stream. */
export interface CaptureArgsHandle {
  breakpointId: string | null
  tag: string
  file: string
  fn: string
  line: number | null
  note: string
}

/**
 * The top paused frame's variables, WITH its limits stated in the shape. The old
 * bare `Record<string, unknown>` could not distinguish "this frame has no locals"
 * from "I dropped them": non-configurable props were skipped, every object became
 * `[object]`, and an outer closure silently overwrote a shadowed local. All three
 * are now either fixed or reported here.
 */
export interface LocalVariablesResult {
  /** Innermost-scope-wins: a local shadowing a closure var reports the LOCAL value. */
  variables: Record<string, unknown>
  frame: {
    functionName: string
    url: string
    line: number
    column: number
    /** Always 0 — this is the TOP frame only. Use `getCallFrames()` for the stack. */
    index: 0
    totalFrames: number
  }
  scopes: Array<{ type: string; variableCount: number; shadowed: string[]; unreadable: boolean }>
  /** `"<path>: <reason>"` for every string value that was capped. */
  cappedValues: string[]
  /** `"<path>: <reason>"` for every container the BROWSER cut short. The value's own
   *  shape is never altered to say so — an array does not grow a marker element. */
  overflowedContainers: string[]
  /** Stated limits, so a caller never mistakes a limit for an absence. */
  limits: {
    topFrameOnly: true
    globalScopeSkipped: boolean
    maxValueLength: number
    note: string
  }
}

// Cap for large scope/logpoint values: keep the value, don't drop it.
const MAX_CAP_LENGTH = 10000

// ---------------------------------------------------------------------------
// CDP value reconstruction
// ---------------------------------------------------------------------------

/**
 * V8 caps a string inside an ObjectPreview at 100 chars and marks the cut with a
 * mid-string `…`. There is no flag for it, so a value of at least this length that
 * contains `…` is reported as possibly-capped rather than presented as whole.
 *
 * MEASURED against Chromium 145.0.7632.18: `({ s: "x".repeat(500) })` with
 * `generatePreview: true` returns a property whose value is EXACTLY 100 characters long
 * and contains `…`. The same 500-character string evaluated on its own — not inside a
 * preview — comes back with all 500, which is why the cap is attributed to the preview
 * and `evaluate({ expression })` is the documented way out.
 */
const PREVIEW_STRING_CAP = 100

/**
 * What the browser's own preview limits hid. Filled while reading a RemoteObject
 * so a caller never has to infer a cap from the value's shape.
 *
 * Entries are `"<path>: <reason>"`. The value shape itself is NEVER altered to
 * carry a cap marker — an array must not grow an extra element to say it was cut.
 */
export interface PreviewReadAccounting {
  /**
   * Containers the browser cut short. MEASURED against Chromium 145.0.7632.18, all with
   * `overflow: true` set on the preview: a 10-property object sends 5 properties, a
   * 300-element array sends 100, and a 20-entry Map and a 20-entry Set each send 5.
   */
  overflowed: string[]
  /** Strings capped, by us at MAX_CAP_LENGTH or by V8's 100-char preview cap. */
  cappedStrings: string[]
}

export function newPreviewAccounting(): PreviewReadAccounting {
  return { overflowed: [], cappedStrings: [] }
}

/**
 * Markers stand in for values that cannot be represented as themselves in JSON, or
 * that the browser never sent. They are deliberately bracketed and type-named so a
 * marker can never be mistaken for the value it describes: `[function]`,
 * `[bigint 9007199254740993n]`, `[symbol Symbol(tag)]`, `[accessor]`,
 * `[date Thu Jan 01 …]`, `[object Object]`, `[array Array(3)]`.
 */
function marker(kind: string, text?: string | null): string {
  const t = (text ?? '').trim()
  return t ? `[${kind} ${t}]` : `[${kind}]`
}

/**
 * A number reconstructed from CDP's text form. `NaN`, `Infinity`, `-Infinity` and
 * `-0` all round-trip exactly (V8 emits the JS `ToString` form). Text that does not
 * parse becomes a marker rather than a wrong number — never a guess.
 */
function numberFromText(text: string | undefined): unknown {
  if (text === undefined) return marker('number')
  const n = Number(text)
  if (Number.isNaN(n) && text !== 'NaN') return marker('number', text)
  return n
}

function capStringValue(
  s: string,
  path: string,
  accounting: PreviewReadAccounting | undefined,
  fromPreview: boolean,
): string {
  if (fromPreview && s.length >= PREVIEW_STRING_CAP && s.includes('…')) {
    accounting?.cappedStrings.push(
      `${path || '(value)'}: matches V8's ${PREVIEW_STRING_CAP}-char preview cap (cut marked with a mid-string …) — use evaluate({ expression }) for the whole string`,
    )
    return s
  }
  if (s.length > MAX_CAP_LENGTH) {
    accounting?.cappedStrings.push(`${path || '(value)'}: capped at ${MAX_CAP_LENGTH} of ${s.length} chars`)
    return s.slice(0, MAX_CAP_LENGTH) + `... (${s.length} chars)`
  }
  return s
}

/** RemoteObject.description for a function is its source; recover just the name. */
function functionNameFromDescription(description?: string): string | null {
  if (!description) return null
  const head = description.slice(0, 200).trimStart()
  let m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(head)
  if (m) return m[1]
  m = /^class\s+([A-Za-z_$][\w$]*)/.exec(head)
  if (m) return `class ${m[1]}`
  // Method shorthand: `name(a) { … }`.
  m = /^(?:async\s+)?(?!function\b)([A-Za-z_$][\w$]*)\s*\(/.exec(head)
  if (m) return m[1]
  return null
}

// Subtypes whose own properties carry no signal: the description IS the value.
const DESCRIBED_SUBTYPES = new Set([
  'date',
  'regexp',
  'node',
  'promise',
  'proxy',
  'iterator',
  'generator',
  'arraybuffer',
  'dataview',
  'webassemblymemory',
  'wasmvalue',
  'trustedtype',
])

interface ReadOpts {
  path?: string
  accounting?: PreviewReadAccounting
  depth?: number
  maxDepth?: number
}

/**
 * The single place CDP types are reconstructed.
 *
 * The distinction that matters: a `RemoteObject`'s `value` is a REAL JS value, but a
 * `PropertyPreview`'s `value` is documented as a "user-friendly property value
 * string" — it is a string for numbers, booleans, null and undefined alike, and the
 * real type lives in `type`/`subtype`. Reading previews without consulting `type`
 * turned the number `10` into the string `"10"`, which is indistinguishable from a
 * genuine `"10"` — a debugger that confirms a type bug that does not exist. So every
 * path below reconstructs from `type` first and only then looks at the text.
 */
export function readRemoteObject(value: Protocol.Runtime.RemoteObject, opts: ReadOpts = {}): unknown {
  const { path = '', accounting, depth = 0, maxDepth = 4 } = opts
  switch (value.type) {
    case 'undefined':
      return undefined
    case 'boolean':
      return value.value !== undefined ? value.value : value.description === 'true'
    case 'number':
      // NaN / ±Infinity / -0 arrive as `unserializableValue` with NO `value`. MEASURED
      // against Chromium 145: each of `NaN`, `Infinity`, `-Infinity` and `-0` comes back
      // as `{type:'number', unserializableValue:'<the literal>', description:'<the same>'}`
      // with the `value` key absent entirely — so `value !== undefined` is the right test
      // and a `?? 0` style default here would turn every one of them into 0.
      return value.value !== undefined ? value.value : numberFromText(value.unserializableValue ?? value.description)
    case 'string':
      return typeof value.value === 'string'
        ? capStringValue(value.value, path, accounting, false)
        : marker('string', value.description)
    case 'bigint':
      // A real BigInt would make JSON.stringify throw, so it is a marker carrying
      // the exact literal (`123n`), which no number and no plain string produces.
      return marker('bigint', value.unserializableValue ?? value.description)
    case 'symbol':
      // Two symbols with the same description are still different symbols: this is
      // a marker, never a comparable value.
      return marker('symbol', value.description)
    case 'function': {
      const name = functionNameFromDescription(value.description)
      return name ? `[function ${name}]` : '[function]'
    }
    case 'object': {
      if (value.subtype === 'null') return null
      // returnByValue payloads are already real JSON values.
      if (value.value !== undefined) return value.value
      if (value.preview) {
        return readObjectPreview(value.preview, { path, accounting, depth, maxDepth })
      }
      return marker(value.subtype ?? 'object', value.description ?? value.className)
    }
    default:
      return marker(String(value.type), value.description)
  }
}

function joinPath(path: string, key: string): string {
  if (!path) return key
  return /^\d+$/.test(key) ? `${path}[${key}]` : `${path}.${key}`
}

/** Reconstruct one preview property. `type` decides; the text is only the payload. */
function readPropertyPreview(p: Protocol.Runtime.PropertyPreview, opts: ReadOpts): unknown {
  const { path = '', accounting, depth = 0, maxDepth = 4 } = opts
  // A getter is NOT invoked: invoking it could mutate the page being measured.
  if (p.type === 'accessor') return '[accessor]'
  // V8 sends an empty `value` for functions in previews — no name is available. MEASURED
  // against Chromium 145: `({ fn: function namedFn(){}, arrow: () => {} })` previews as
  // `[{name:'fn',type:'function',value:''}, {name:'arrow',type:'function',value:''}]`, so
  // even a NAMED function carries nothing to recover the name from at this level.
  if (p.type === 'function') return '[function]'
  if (p.valuePreview) return readObjectPreview(p.valuePreview, { path, accounting, depth: depth + 1, maxDepth })
  return primitiveFromText(p.type, p.subtype, p.value, { path, accounting, depth, maxDepth })
}

/**
 * Map/Set entries arrive as ObjectPreviews whose primitive payload is in
 * `description`, so the same reconstruction applies with a different field.
 */
function readEntryPreview(op: Protocol.Runtime.ObjectPreview, opts: ReadOpts): unknown {
  const { path = '', accounting, depth = 0, maxDepth = 4 } = opts
  if (op.type === 'function') return '[function]'
  if (op.type === 'object' && op.subtype !== 'null') {
    return readObjectPreview(op, { path, accounting, depth: depth + 1, maxDepth })
  }
  return primitiveFromText(op.type, op.subtype, op.description, { path, accounting, depth, maxDepth })
}

function primitiveFromText(
  type: string,
  subtype: string | undefined,
  text: string | undefined,
  { path = '', accounting }: ReadOpts,
): unknown {
  switch (type) {
    case 'number':
      return numberFromText(text)
    case 'boolean':
      return text === 'true'
    case 'undefined':
      return undefined
    case 'string':
      return capStringValue(text ?? '', path, accounting, true)
    case 'bigint':
      return marker('bigint', text)
    case 'symbol':
      return marker('symbol', text)
    case 'object':
      if (subtype === 'null') return null
      // A nested object the browser did not preview: its CONTENT was never sent, so
      // the shape description is a marker, not a value. `'Object'` as a bare string
      // would read as the string "Object".
      return marker(subtype ?? 'object', text)
    default:
      return marker(type, text)
  }
}

export function readObjectPreview(preview: Protocol.Runtime.ObjectPreview, opts: ReadOpts = {}): unknown {
  const { path = '', accounting, depth = 0, maxDepth = 4 } = opts
  if (depth > maxDepth) return marker(preview.subtype ?? preview.type, preview.description)
  const sub = preview.subtype
  const child = { accounting, depth, maxDepth }

  if (sub === 'map' || sub === 'set' || sub === 'weakmap' || sub === 'weakset') {
    const entries: unknown[] = []
    for (const e of preview.entries ?? []) {
      const p = joinPath(path, `${entries.length}`)
      entries.push(
        e.key !== undefined
          ? [readEntryPreview(e.key, { ...child, path: `${p}.key` }), readEntryPreview(e.value, { ...child, path: `${p}.value` })]
          : readEntryPreview(e.value, { ...child, path: p }),
      )
    }
    if (preview.overflow) {
      accounting?.overflowed.push(
        `${path || '(value)'}: ${preview.description ?? sub} — the browser sent only ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`,
      )
    }
    // A Map is not a plain object: rendering it as `{ size: 2 }` (which is what
    // reading only `properties` did) loses every entry it contains.
    return { '[collection]': preview.description ?? sub, '[entries]': entries }
  }

  if (sub === 'array' || sub === 'typedarray') {
    const arr: unknown[] = []
    const extras: string[] = []
    for (const p of preview.properties) {
      const v = readPropertyPreview(p, { ...child, path: joinPath(path, p.name) })
      if (/^\d+$/.test(p.name)) arr[Number(p.name)] = v
      // A non-index own property on an array (`arr.foo = 1`) must not become an
      // element; it is reported instead of silently lengthening the array.
      else extras.push(p.name)
    }
    if (preview.overflow) {
      accounting?.overflowed.push(
        `${path || '(value)'}: ${preview.description ?? 'array'} — the browser sent only the first ${arr.length} item(s)`,
      )
    }
    if (extras.length) {
      accounting?.overflowed.push(
        `${path || '(value)'}: non-index propert${extras.length === 1 ? 'y' : 'ies'} ${extras.join(', ')} exist on this array and are not part of its element shape`,
      )
    }
    return arr
  }

  if (sub === 'error') {
    const obj: Record<string, unknown> = { '[error]': (preview.description ?? 'Error').split('\n')[0] }
    for (const p of preview.properties) obj[p.name] = readPropertyPreview(p, { ...child, path: joinPath(path, p.name) })
    return obj
  }

  if (sub && DESCRIBED_SUBTYPES.has(sub)) {
    // A Date's own properties are empty: reading them produced `{}`, which reads as
    // an empty object rather than as a Date. MEASURED against Chromium 145: `new Date(0)`
    // previews as `{subtype:'date', properties:[]}` with the whole value carried in
    // `description` ("Thu Jan 01 1970 01:00:00 GMT+0100 …").
    return marker(sub, preview.description)
  }

  const obj: Record<string, unknown> = {}
  for (const p of preview.properties) obj[p.name] = readPropertyPreview(p, { ...child, path: joinPath(path, p.name) })
  if (preview.overflow) {
    accounting?.overflowed.push(
      `${path || '(value)'}: the browser sent only ${preview.properties.length} of this object's properties`,
    )
  }
  return obj
}

/**
 * Reconstruct a thrown exception from CDP's `ExceptionDetails`.
 *
 * The thrown value arrives as a RemoteObject that is NOT subject to `returnByValue`, so
 * its `description` is the real `Error: message\n    at …` text — the only place the
 * message survives when the caller asked for values by value.
 */
export function readExceptionDetails(details: Protocol.Runtime.ExceptionDetails): EvaluateThrow {
  const exception = details.exception
  const description = exception?.description
  // `description` is message + stack; the first line is the message on its own.
  const firstLine = description ? description.split('\n')[0] : undefined
  const message =
    firstLine ??
    (typeof exception?.value === 'string' ? exception.value : undefined) ??
    details.text ??
    'the expression threw a value CDP did not describe'
  return {
    message,
    ...(exception?.className ? { className: exception.className } : {}),
    ...(description && description.includes('\n') ? { stack: description } : {}),
    text: details.text ?? 'Uncaught',
    ...(details.lineNumber != null ? { lineNumber: details.lineNumber } : {}),
    ...(details.columnNumber != null ? { columnNumber: details.columnNumber } : {}),
  }
}

/** Default cap on a logpoint's JSON payload, applied IN the page before logging. */
export const LOGPOINT_PAYLOAD_MAX = 2000

/** Tag characters that survive into the `[[logpoint:TAG]]` marker unchanged. */
function sanitizeLogpointTag(tag: string): string {
  const cleaned = tag.replace(/[^A-Za-z0-9_.:@/-]/g, '_').slice(0, 64)
  return cleaned.length ? cleaned : 'lp'
}

/**
 * Build the breakpoint condition for a logpoint. The shape is load-bearing, not
 * cosmetic: a breakpoint whose condition can ever evaluate truthy PAUSES the page,
 * which reorders timers on resume and destroys exactly the race-class hypotheses
 * this lane exists to test. So the condition is an IIFE whose only outer-function
 * return is `return false`, with every failure mode (a throwing expression, a
 * circular value, an oversized payload) folded into a JSON envelope instead of an
 * exception. `verifyNonPausingCondition` then PROVES that property over the
 * assembled string, so a hostile or malformed `expr` cannot smuggle a pause in.
 *
 * `globalThis.JSON` / `globalThis.console` are used deliberately: a paused frame
 * may have a local named `JSON` or `console` shadowing the intrinsic.
 */
export function buildLogpointCondition({
  tag,
  expr,
  maxPayload = LOGPOINT_PAYLOAD_MAX,
}: {
  tag?: string
  expr: string
  maxPayload?: number
}): string {
  const t = sanitizeLogpointTag(tag ?? 'lp')
  const cap = Math.max(64, Math.floor(maxPayload))
  return (
    '(function(){' +
    'var __pwJ=globalThis.JSON,__pwP;' +
    'try{' +
    'var __pwV=(' +
    expr +
    ');' +
    'try{__pwP=__pwJ.stringify(__pwV)}catch(__pwE){__pwP=__pwJ.stringify({__playwriter_logpoint_error:"JSON.stringify threw: "+(__pwE&&__pwE.message)})}' +
    'if(__pwP===undefined){__pwP=__pwJ.stringify({__playwriter_logpoint_undefined:true})}' +
    'if(__pwP.length>' +
    cap +
    '){__pwP=__pwJ.stringify({__playwriter_logpoint_truncated:__pwP.length,head:__pwP.slice(0,' +
    cap +
    ')})}' +
    '}catch(__pwE2){__pwP=__pwJ.stringify({__playwriter_logpoint_error:"expression threw: "+(__pwE2&&__pwE2.message)})}' +
    'try{globalThis.console.log("[[logpoint:' +
    t +
    ']] "+__pwP)}catch(__pwE3){}' +
    'return false' +
    '})()'
  )
}

export interface NonPausingCheck {
  nonPausing: boolean
  problems: string[]
}

// Walk raw Babel nodes without @babel/traverse: we only need "is there a
// DebuggerStatement" and "what does the OUTER function return", and traverse
// wants a File/scope it does not need here.
function walkNodes(node: unknown, visit: (n: { type: string } & Record<string, any>, fnDepth: number) => void, fnDepth = 0): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkNodes(child, visit, fnDepth)
    return
  }
  const n = node as { type?: string } & Record<string, any>
  if (typeof n.type !== 'string') return
  visit(n as { type: string } & Record<string, any>, fnDepth)
  const nextDepth =
    n.type === 'FunctionExpression' ||
    n.type === 'FunctionDeclaration' ||
    n.type === 'ArrowFunctionExpression' ||
    n.type === 'ObjectMethod' ||
    n.type === 'ClassMethod'
      ? fnDepth + 1
      : fnDepth
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'extra') continue
    walkNodes(n[key], visit, nextDepth)
  }
}

/**
 * PROVE that a breakpoint condition can never pause. Checks, over the assembled
 * condition string (not over the caller's promise about it):
 *
 *   1. it parses as exactly ONE expression statement — no statement injection;
 *   2. that expression is an immediately-invoked function expression;
 *   3. every `return` belonging to the OUTER function returns the literal `false`
 *      (an injected `return true` is therefore caught even if it parses);
 *   4. there is no `debugger` statement anywhere — that pauses regardless of the
 *      condition's value.
 */
export function verifyNonPausingCondition(condition: string): NonPausingCheck {
  const problems: string[] = []
  let program: { body: any[] }
  try {
    program = parse(condition, { sourceType: 'script', errorRecovery: false }).program
  } catch (e) {
    return { nonPausing: false, problems: [`condition does not parse: ${(e as Error).message}`] }
  }
  if (program.body.length !== 1 || program.body[0]?.type !== 'ExpressionStatement') {
    problems.push(
      `condition must be a single expression; parsed ${program.body.length} statement(s) [${program.body
        .map((s: any) => s.type)
        .join(', ')}]`,
    )
  }
  const outer = program.body[0]?.type === 'ExpressionStatement' ? program.body[0].expression : null
  if (!outer || outer.type !== 'CallExpression' || outer.callee?.type !== 'FunctionExpression') {
    problems.push('condition must be an immediately-invoked function expression')
  }
  walkNodes(program.body, (n, fnDepth) => {
    if (n.type === 'DebuggerStatement') {
      problems.push('condition contains a `debugger` statement, which pauses regardless of the condition value')
    }
    // fnDepth 1 == the body of the outer IIFE (the callee FunctionExpression).
    if (n.type === 'ReturnStatement' && fnDepth === 1) {
      const arg = n.argument
      if (!arg || arg.type !== 'BooleanLiteral' || arg.value !== false) {
        problems.push(`outer function returns \`${arg ? arg.type : 'void'}\` instead of the literal \`false\``)
      }
    }
  })
  return { nonPausing: problems.length === 0, problems }
}

/**
 * A class for debugging JavaScript code via Chrome DevTools Protocol.
 * Works with both Node.js (--inspect) and browser debugging.
 *
 * @example
 * ```ts
 * const cdp = await getCDPSessionForPage({ page, wsUrl })
 * const dbg = new Debugger({ cdp })
 *
 * await dbg.setBreakpoint({ file: 'https://example.com/app.js', line: 42 })
 * // trigger the code path, then:
 * const location = await dbg.getLocation()
 * const { variables, limits } = await dbg.inspectLocalVariables()
 * await dbg.resume()
 * ```
 */
export class Debugger {
  private cdp: ICDPSession
  private debuggerEnabled = false
  private paused = false
  private currentCallFrames: Protocol.Debugger.CallFrame[] = []
  private breakpoints = new Map<string, BreakpointInfo>()
  private scripts = new Map<string, ScriptInfo>()
  private xhrBreakpoints = new Set<string>()
  private blackboxPatterns: string[] = []
  // Depth counter (not a boolean) so nested `runNonPausingOnly` calls compose.
  private nonPausingOnlyDepth = 0
  private nonPausingOnlyReason: string | null = null

  /**
   * Creates a new Debugger instance.
   *
   * @param options - Configuration options
   * @param options.cdp - A CDPSession instance for sending CDP commands (works with both
   *                      our CDPSession and Playwright's CDPSession)
   *
   * @example
   * ```ts
   * const cdp = await getCDPSessionForPage({ page, wsUrl })
   * const dbg = new Debugger({ cdp })
   * ```
   */
  constructor({ cdp }: { cdp: ICDPSession }) {
    this.cdp = cdp
    this.setupEventListeners()
  }

  private setupEventListeners() {
    this.cdp.on('Debugger.paused', (params) => {
      this.paused = true
      this.currentCallFrames = params.callFrames
    })

    this.cdp.on('Debugger.resumed', () => {
      this.paused = false
      this.currentCallFrames = []
    })

    this.cdp.on('Debugger.scriptParsed', (params) => {
      if (params.url && !params.url.startsWith('chrome') && !params.url.startsWith('devtools')) {
        this.scripts.set(params.scriptId, {
          scriptId: params.scriptId,
          url: params.url,
        })
      }
    })
  }

  /**
   * Enables the Debugger domain. Called automatically by other methods. Also resumes
   * execution if the target was started with --inspect-brk.
   *
   * It does NOT touch the Runtime domain, and that omission is load-bearing.
   *
   * This session is usually Playwright's OWN page session (`getExistingCDPSession`),
   * shared with everything else in the process. Measured against real Chromium, a
   * `Runtime.disable` followed by `Runtime.enable` makes V8 REPLAY its entire console
   * buffer: every line the page had already logged is delivered a second time, plus
   * Playwright's internal `--playwright--set--content--…` markers, and it happens again
   * on every subsequent cycle. Downstream that is not cosmetic — `readLogpoints` scans
   * the same log array, so a replayed `[[logpoint:TAG]]` line is counted as a fresh hit
   * and "this code path ran once" reads as "it ran twice".
   *
   * Nothing here needed those two calls. Measured, with only `Debugger.enable` sent:
   * `Debugger.scriptParsed` arrives for every already-parsed script (that is what
   * repopulates `this.scripts`, and it is `Debugger.disable`/`enable` — not Runtime —
   * that re-emits them); `Runtime.evaluate`, `Runtime.getProperties` and
   * `Runtime.globalLexicalScopeNames` all answer without `Runtime.enable`; breakpoints
   * bind and `Debugger.paused` fires. Playwright's own `page.evaluate` and console
   * capture keep working throughout, with zero replayed lines.
   */
  async enable(): Promise<void> {
    if (this.debuggerEnabled) {
      return
    }
    await this.cdp.send('Debugger.disable')
    this.scripts.clear()
    const scriptsReady = new Promise<void>((resolve) => {
      let timeout: ReturnType<typeof setTimeout>
      const listener = () => {
        clearTimeout(timeout)
        timeout = setTimeout(() => {
          this.cdp.off('Debugger.scriptParsed', listener)
          resolve()
        }, 100)
      }
      this.cdp.on('Debugger.scriptParsed', listener)
      timeout = setTimeout(() => {
        this.cdp.off('Debugger.scriptParsed', listener)
        resolve()
      }, 100)
    })
    await this.cdp.send('Debugger.enable')
    await this.cdp.send('Runtime.runIfWaitingForDebugger')
    await scriptsReady
    this.debuggerEnabled = true
  }

  /**
   * Sets a breakpoint at a specified URL and line number.
   * Use the URL from listScripts() to find available scripts.
   *
   * @param options - Breakpoint options
   * @param options.file - Script URL (e.g. https://example.com/app.js)
   * @param options.line - Line number (1-based)
   * @param options.condition - Optional JS expression; only pause when it evaluates to true
   * @returns The breakpoint ID for later removal
   *
   * @example
   * ```ts
   * const id = await dbg.setBreakpoint({ file: 'https://example.com/app.js', line: 42 })
   * // later:
   * await dbg.deleteBreakpoint({ breakpointId: id })
   *
   * // Conditional breakpoint - only pause when userId is 123
   * await dbg.setBreakpoint({
   *   file: 'https://example.com/app.js',
   *   line: 42,
   *   condition: 'userId === 123'
   * })
   * ```
   */
  async setBreakpoint({
    file,
    line,
    condition,
    requireBinding = false,
  }: {
    file: string
    line: number
    condition?: string
    /**
     * Refuse to report success unless V8 bound the breakpoint to a real location.
     *
     * Default `false`, because arming a breakpoint BEFORE the script loads is a
     * legitimate use (it binds on `scriptParsed`), and throwing there would break it.
     * `setLogpoint` defaults it to `true`: a logpoint is a MEASUREMENT, and an unbound
     * one produces no hits, which is indistinguishable from a code path that never ran.
     */
    requireBinding?: boolean
  }): Promise<string> {
    await this.enable()

    // A condition is only "non-pausing" when it is PROVEN so; an absent condition
    // always pauses. Inside `runNonPausingOnly` a pausing breakpoint is refused
    // rather than trusted, because pausing reorders timers on resume.
    const check = condition ? verifyNonPausingCondition(condition) : { nonPausing: false, problems: ['no condition: an unconditional breakpoint always pauses'] }
    if (this.nonPausingOnlyDepth > 0 && !check.nonPausing) {
      throw new Error(
        `refusing to set a pausing breakpoint at ${file}:${line} while non-pausing-only mode is active` +
          `${this.nonPausingOnlyReason ? ` (${this.nonPausingOnlyReason})` : ''}: ${check.problems.join('; ')}. ` +
          `Use setLogpoint() instead — pausing here reorders timers on resume and invalidates the measurement.`,
      )
    }

    const response = await this.cdp.send('Debugger.setBreakpointByUrl', {
      lineNumber: line - 1,
      urlRegex: buildBreakpointUrlRegex(file),
      columnNumber: 0,
      condition,
    })

    const locations = response.locations ?? []
    const resolvedLocations = locations.map((location) => ({
      scriptId: location.scriptId,
      url: this.scripts.get(location.scriptId)?.url ?? '',
      lineNumber: location.lineNumber,
      ...(location.columnNumber != null ? { columnNumber: location.columnNumber } : {}),
    }))
    const bound = resolvedLocations.length > 0

    if (!bound && requireBinding) {
      // Remove the phantom: leaving it registered would let `listBreakpoints()` show a
      // breakpoint that can never fire.
      await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: response.breakpointId }).catch(() => {})
      const known = Array.from(this.scripts.values()).map((s) => s.url)
      const near = known.filter((url) => url.includes(file) || file.includes(url)).slice(0, 5)
      throw new Error(
        `Debugger.setBreakpointByUrl returned an id for ${file}:${line} but bound it to NO location, so it can never ` +
          `fire. An id is not a binding — CDP returns one even for a URL no script has. ` +
          (near.length
            ? `Scripts whose URL is related: ${near.join(', ')}. `
            : `No loaded script URL contains "${file}". `) +
          `Either the file does not match any loaded script (use listScripts() to see the ${known.length} loaded ` +
          `URLs), or line ${line} is past the end of it, or the script has not loaded yet. Reporting this as a ` +
          `successfully-armed probe would make "never executed" and "never installed" look identical.`,
      )
    }

    this.breakpoints.set(response.breakpointId, {
      id: response.breakpointId,
      file,
      line,
      condition,
      nonPausing: check.nonPausing,
      bound,
      resolvedLocations,
    })
    return response.breakpointId
  }

  /**
   * Run `fn` with pausing capture STRUCTURALLY refused: `setBreakpoint` without a
   * provably non-pausing condition, `setPauseOnExceptions` (other than 'none') and
   * `setXHRBreakpoint` all throw for the duration. Race-class probes wrap their run
   * in this so the non-destructive-capture guarantee is enforced rather than documented.
   *
   * THE MEASUREMENT THIS EXISTS FOR
   * ------------------------------
   * Measured against Chromium 145.0.7632.18, holding a `debugger` pause for 900ms while
   * two independent async sources were in flight — a `setTimeout` due at 500ms and a
   * response from a local HTTP server due at 100ms:
   *
   *     no pause      fetch -> timer     10 runs out of 10
   *     900ms pause   timer -> fetch     10 runs out of 10
   *
   * The observed order is INVERTED, deterministically. Both were due by the time the page
   * resumed, and V8 drains the timer queue before the resumed network callback — so a
   * probe measuring "which of these two landed first" reads the exact opposite of the
   * truth, with nothing in its output to say a pause happened.
   *
   * Timer-against-timer is a different and milder failure, measured on the same build:
   * six interleaved timers at 0/100/200/300/400/500ms kept their relative order across a
   * pause (`A0 B1 A2 B3 A4 B5` both ways), but the four that came due during the pause all
   * fired in the SAME millisecond on resume — inter-callback gaps went from
   * `99,100,100,100,100` to `100,960,0,0,0`. So the sequence survives and every interval
   * between the events is destroyed.
   *
   * Either way an ordering or timing hypothesis measured through a pause is fiction, which
   * is why this refuses rather than warns.
   *
   * The other half of the original justification — that a pausing breakpoint also stalls
   * the relay's navigation bookkeeping — is NOT MEASURED HERE: it needs the extension relay
   * in the path, and this measurement is direct CDP to headless Chromium. Treat it as an
   * assumption. The reordering above stands on its own as the reason for this mode.
   */
  async runNonPausingOnly<T>(fn: () => Promise<T> | T, { reason }: { reason?: string } = {}): Promise<T> {
    this.nonPausingOnlyDepth++
    const prevReason = this.nonPausingOnlyReason
    if (reason) this.nonPausingOnlyReason = reason
    try {
      return await fn()
    } finally {
      this.nonPausingOnlyDepth--
      this.nonPausingOnlyReason = this.nonPausingOnlyDepth > 0 ? prevReason : null
    }
  }

  /** True while inside `runNonPausingOnly`. */
  isNonPausingOnly(): boolean {
    return this.nonPausingOnlyDepth > 0
  }

  /**
   * Removes a breakpoint by its ID.
   *
   * @param options - Options
   * @param options.breakpointId - The breakpoint ID returned by setBreakpoint
   *
   * @example
   * ```ts
   * await dbg.deleteBreakpoint({ breakpointId: 'bp-123' })
   * ```
   */
  async deleteBreakpoint({ breakpointId }: { breakpointId: string }): Promise<void> {
    await this.enable()
    await this.cdp.send('Debugger.removeBreakpoint', { breakpointId })
    this.breakpoints.delete(breakpointId)
  }

  /**
   * Returns a list of all active breakpoints set by this debugger instance.
   *
   * @returns Array of breakpoint info objects
   *
   * @example
   * ```ts
   * const breakpoints = dbg.listBreakpoints()
   * // [{ id: 'bp-123', file: 'https://example.com/index.js', line: 42 }]
   * ```
   */
  listBreakpoints(): BreakpointInfo[] {
    return Array.from(this.breakpoints.values())
  }

  /**
   * Read the TOP paused frame's variables (local + closure + block scopes).
   *
   * The limits are part of the return value on purpose. Three earlier behaviours
   * made this method quietly lie and are fixed here:
   *   - scopes were merged with plain assignment, so an OUTER closure variable
   *     overwrote a shadowing local: the reported value belonged to the wrong
   *     binding. Innermost scope now wins and the shadowed names are listed.
   *   - every object/array collapsed to the string `[object]` / `[array]`, which
   *     reads like a value. Content is kept (capped) via the same reader
   *     `getCallFrames` uses.
   *   - properties with `configurable: false` were dropped silently. They are read
   *     like any other now.
   *   - nested values were read straight out of `PropertyPreview.value`, which CDP
   *     documents as a STRING for every type: the number `10` came back as `"10"`,
   *     indistinguishable from a genuine `"10"`. `readRemoteObject` reconstructs
   *     from `type`/`subtype`, so nested numbers, booleans, `null` and `undefined`
   *     keep their real types.
   *
   * Still top-frame-only — `getCallFrames()` walks the whole stack.
   *
   * @throws Error if not paused or no active call frames
   *
   * @example
   * ```ts
   * const { variables, limits } = await dbg.inspectLocalVariables()
   * // variables: { myVar: 'hello', count: 42 }
   * ```
   */
  async inspectLocalVariables(): Promise<LocalVariablesResult> {
    await this.enable()

    if (!this.paused || this.currentCallFrames.length === 0) {
      throw new Error('Debugger is not paused at a breakpoint')
    }

    const frame = this.currentCallFrames[0]
    const variables: Record<string, unknown> = {}
    const scopes: LocalVariablesResult['scopes'] = []
    const accounting = newPreviewAccounting()
    let globalScopeSkipped = false

    for (const scopeObj of frame.scopeChain) {
      if (scopeObj.type === 'global') {
        // The global scope is thousands of names of near-zero signal; say so.
        globalScopeSkipped = true
        continue
      }

      if (!scopeObj.object.objectId) {
        scopes.push({ type: scopeObj.type, variableCount: 0, shadowed: [], unreadable: true })
        continue
      }

      let props: Protocol.Runtime.GetPropertiesResponse
      try {
        props = await this.cdp.send('Runtime.getProperties', {
          objectId: scopeObj.object.objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: true,
        })
      } catch {
        scopes.push({ type: scopeObj.type, variableCount: 0, shadowed: [], unreadable: true })
        continue
      }

      const shadowed: string[] = []
      let count = 0
      for (const prop of props.result) {
        if (!prop.value) continue
        count++
        // scopeChain is innermost-first: a name already present came from a nearer
        // scope and must NOT be overwritten by this outer one.
        if (Object.prototype.hasOwnProperty.call(variables, prop.name)) {
          shadowed.push(prop.name)
          continue
        }
        variables[prop.name] = readRemoteObject(prop.value, { path: prop.name, accounting })
      }
      scopes.push({ type: scopeObj.type, variableCount: count, shadowed, unreadable: false })
    }

    return {
      variables,
      frame: {
        functionName: frame.functionName || '(anonymous)',
        url: frame.url,
        line: frame.location.lineNumber + 1,
        column: frame.location.columnNumber ?? 0,
        index: 0,
        totalFrames: this.currentCallFrames.length,
      },
      scopes,
      cappedValues: accounting.cappedStrings,
      overflowedContainers: accounting.overflowed,
      limits: {
        topFrameOnly: true,
        globalScopeSkipped,
        maxValueLength: MAX_CAP_LENGTH,
        note:
          `top frame only (${this.currentCallFrames.length} frame(s) on the stack) — use getCallFrames() for the whole stack; ` +
          `strings over ${MAX_CAP_LENGTH} chars carry an inline "... (N chars)" marker; ` +
          `objects are read one preview level deep (the browser sends ~5 object properties, 100 array items and 5 map/set ` +
          `entries per preview — everything it cut is listed in overflowedContainers, and nested strings are capped by V8 at ` +
          `${PREVIEW_STRING_CAP} chars); values that JSON cannot hold are bracketed markers (\`[function name]\`, ` +
          `\`[bigint 1n]\`, \`[symbol Symbol(x)]\`, \`[accessor]\`, \`[date …]\`, \`[object Object]\` for a container the ` +
          `browser never sent); an \`undefined\` value disappears when this result is JSON-serialised — check \`scopes[].variableCount\`; ` +
          `use evaluate({ expression }) for anything deeper or whole`,
      },
    }
  }

  /**
   * Returns global lexical scope variable names.
   *
   * @returns Array of global variable names
   *
   * @example
   * ```ts
   * const globals = await dbg.inspectGlobalVariables()
   * // ['myGlobal', 'CONFIG']
   * ```
   */
  async inspectGlobalVariables(): Promise<string[]> {
    await this.enable()

    const response = await this.cdp.send('Runtime.globalLexicalScopeNames', {})

    return response.names
  }

  /**
   * Evaluates a JavaScript expression and returns the result.
   * When paused at a breakpoint, evaluates in the current stack frame scope,
   * allowing access to local variables. Otherwise evaluates in global scope.
   * Values are not truncated, use this for full control over reading specific variables.
   *
   * A thrown expression is reported in `threw`, never as a value. The expression is sent
   * to V8 UNWRAPPED so `exceptionDetails` survives: the old `try { … } catch (e) { e }`
   * wrapper turned a throw into the completion value, and `returnByValue: true` then
   * serialised the `Error` to `{}` — indistinguishable from a genuine empty object.
   *
   * @param options - Options
   * @param options.expression - JavaScript expression to evaluate
   * @returns `{ value }` on success; `{ value: undefined, threw }` when it threw.
   *
   * @example
   * ```ts
   * // When paused, can access local variables:
   * const result = await dbg.evaluate({ expression: 'localVar + 1' })
   *
   * // Read a large string that would be capped in inspectLocalVariables:
   * const full = await dbg.evaluate({ expression: 'largeStringVar' })
   *
   * // A throw is a throw, not an empty object:
   * const bad = await dbg.evaluate({ expression: 'throw new Error("boom")' })
   * if (bad.threw) console.error(bad.threw.message) // 'Error: boom'
   * ```
   */
  async evaluate({ expression }: { expression: string }): Promise<EvaluateResult> {
    await this.enable()

    let response: Protocol.Debugger.EvaluateOnCallFrameResponse | Protocol.Runtime.EvaluateResponse

    if (this.paused && this.currentCallFrames.length > 0) {
      const frame = this.currentCallFrames[0]
      response = await this.cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression,
        objectGroup: 'console',
        includeCommandLineAPI: true,
        silent: false,
        returnByValue: true,
        generatePreview: true,
      })
    } else {
      response = await this.cdp.send('Runtime.evaluate', {
        expression,
        objectGroup: 'console',
        includeCommandLineAPI: true,
        silent: false,
        returnByValue: true,
        generatePreview: true,
        awaitPromise: true,
      })
    }

    // `exceptionDetails` is the ONLY signal that separates a throw from a value, and it
    // is read first for that reason.
    //
    // What `result` actually holds on a throw, MEASURED against Chromium 145.0.7632.18
    // (both `Runtime.evaluate` and `Debugger.evaluateOnCallFrame`, `returnByValue: true`):
    // NOT `{}`. It is an unserialised RemoteObject —
    // `{ type:'object', subtype:'error', className:'Error', description:'Error: boom\n at …',
    // objectId:'…' }` — with no `value` field at all, because `returnByValue` does not
    // apply to a thrown object. `{}` is what the OLD wrapped form produced: measured,
    // `try { throw new Error("boom") } catch (e) { e }` under `returnByValue: true` returns
    // `{ type:'object', value: {} }` and no `exceptionDetails` whatsoever — the throw had
    // become an ordinary completion value, indistinguishable from evaluating `({})`. That
    // is the bug this method's shape exists to prevent, and the reason it is stated here
    // is that a previous version of this comment attributed the `{}` to the CURRENT
    // unwrapped path, where it does not occur.
    if (response.exceptionDetails) {
      return { value: undefined, threw: readExceptionDetails(response.exceptionDetails) }
    }

    const value = await this.processRemoteObject(response.result)

    return { value }
  }

  /**
   * Gets the current execution location when paused at a breakpoint.
   * Includes the call stack and surrounding source code for context.
   *
   * @returns Location info with URL, line number, call stack, and source context
   * @throws Error if debugger is not paused
   *
   * @example
   * ```ts
   * const location = await dbg.getLocation()
   * console.log(location.url)          // 'https://example.com/src/index.js'
   * console.log(location.lineNumber)   // 42
   * console.log(location.callstack)    // [{ functionName: 'handleRequest', ... }]
   * console.log(location.sourceContext)
   * // '  40: function handleRequest(req) {
   * //   41:   const data = req.body
   * // > 42:   processData(data)
   * //   43: }'
   * ```
   */
  async getLocation(): Promise<LocationInfo> {
    await this.enable()

    if (!this.paused || this.currentCallFrames.length === 0) {
      throw new Error('Debugger is not paused at a breakpoint')
    }

    const frame = this.currentCallFrames[0]
    const { scriptId, lineNumber, columnNumber } = frame.location

    const callstack = this.currentCallFrames.map((f) => ({
      functionName: f.functionName || '(anonymous)',
      url: f.url,
      lineNumber: f.location.lineNumber + 1,
      columnNumber: f.location.columnNumber || 0,
    }))

    let sourceContext = ''
    try {
      const scriptSource = await this.cdp.send('Debugger.getScriptSource', { scriptId })
      const lines = scriptSource.scriptSource.split('\n')
      const startLine = Math.max(0, lineNumber - 3)
      const endLine = Math.min(lines.length - 1, lineNumber + 3)

      for (let i = startLine; i <= endLine; i++) {
        const prefix = i === lineNumber ? '> ' : '  '
        sourceContext += `${prefix}${i + 1}: ${lines[i]}\n`
      }
    } catch {
      sourceContext = 'Unable to retrieve source code'
    }

    return {
      url: frame.url,
      lineNumber: lineNumber + 1,
      columnNumber: columnNumber || 0,
      callstack,
      sourceContext,
    }
  }

  /**
   * Steps over to the next line of code, not entering function calls.
   *
   * @throws Error if debugger is not paused
   *
   * @example
   * ```ts
   * await dbg.stepOver()
   * const newLocation = await dbg.getLocation()
   * ```
   */
  async stepOver(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.stepOver')
  }

  /**
   * Steps into a function call on the current line.
   *
   * @throws Error if debugger is not paused
   *
   * @example
   * ```ts
   * await dbg.stepInto()
   * const location = await dbg.getLocation()
   * // now inside the called function
   * ```
   */
  async stepInto(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.stepInto')
  }

  /**
   * Steps out of the current function, returning to the caller.
   *
   * @throws Error if debugger is not paused
   *
   * @example
   * ```ts
   * await dbg.stepOut()
   * const location = await dbg.getLocation()
   * // back in the calling function
   * ```
   */
  async stepOut(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.stepOut')
  }

  /**
   * Resumes code execution until the next breakpoint or completion.
   *
   * @throws Error if debugger is not paused
   *
   * @example
   * ```ts
   * await dbg.resume()
   * // execution continues
   * ```
   */
  async resume(): Promise<void> {
    await this.enable()
    if (!this.paused) {
      throw new Error('Debugger is not paused')
    }
    await this.cdp.send('Debugger.resume')
  }

  /**
   * Returns whether the debugger is currently paused at a breakpoint.
   *
   * @returns true if paused, false otherwise
   *
   * @example
   * ```ts
   * if (dbg.isPaused()) {
   *   const { variables } = await dbg.inspectLocalVariables()
   * }
   * ```
   */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Configures the debugger to pause on exceptions.
   *
   * @param options - Options
   * @param options.state - When to pause: 'none' (never), 'uncaught' (only uncaught), or 'all' (all exceptions)
   *
   * @example
   * ```ts
   * // Pause only on uncaught exceptions
   * await dbg.setPauseOnExceptions({ state: 'uncaught' })
   *
   * // Pause on all exceptions (caught and uncaught)
   * await dbg.setPauseOnExceptions({ state: 'all' })
   *
   * // Disable pausing on exceptions
   * await dbg.setPauseOnExceptions({ state: 'none' })
   * ```
   */
  async setPauseOnExceptions({ state }: { state: 'none' | 'uncaught' | 'all' }): Promise<void> {
    await this.enable()
    if (state !== 'none' && this.nonPausingOnlyDepth > 0) {
      throw new Error(
        `refusing setPauseOnExceptions({ state: '${state}' }) while non-pausing-only mode is active` +
          `${this.nonPausingOnlyReason ? ` (${this.nonPausingOnlyReason})` : ''}: an exception pause reorders async ` +
          `callbacks on resume (measured: a 900ms pause inverts a timer-vs-network ordering 10 runs out of 10 — see runNonPausingOnly).`,
      )
    }
    await this.cdp.send('Debugger.setPauseOnExceptions', { state })
  }

  /**
   * Lists available scripts where breakpoints can be set.
   * Automatically enables the debugger if not already enabled.
   *
   * @param options - Options
   * @param options.search - Optional string to filter scripts by URL (case-insensitive)
   * @returns Array of up to 20 matching scripts with scriptId and url
   *
   * @example
   * ```ts
   * // List all scripts
   * const scripts = await dbg.listScripts()
   * // [{ scriptId: '1', url: 'https://example.com/app.js' }, ...]
   *
   * // Search for specific files
   * const handlers = await dbg.listScripts({ search: 'handler' })
   * // [{ scriptId: '5', url: 'https://example.com/handlers.js' }]
   * ```
   */
  async listScripts({ search }: { search?: string } = {}): Promise<ScriptInfo[]> {
    await this.enable()
    const scripts = Array.from(this.scripts.values())
    const filtered = search ? scripts.filter((s) => s.url.toLowerCase().includes(search.toLowerCase())) : scripts
    return filtered.slice(0, 20)
  }

  async setXHRBreakpoint({ url }: { url: string }): Promise<void> {
    await this.enable()
    if (this.nonPausingOnlyDepth > 0) {
      throw new Error(
        `refusing setXHRBreakpoint({ url: ${JSON.stringify(url)} }) while non-pausing-only mode is active` +
          `${this.nonPausingOnlyReason ? ` (${this.nonPausingOnlyReason})` : ''}: it pauses on the request, which is exactly the ordering under test.`,
      )
    }
    await this.cdp.send('DOMDebugger.setXHRBreakpoint', { url })
    this.xhrBreakpoints.add(url)
  }

  async removeXHRBreakpoint({ url }: { url: string }): Promise<void> {
    await this.enable()
    await this.cdp.send('DOMDebugger.removeXHRBreakpoint', { url })
    this.xhrBreakpoints.delete(url)
  }

  listXHRBreakpoints(): string[] {
    return Array.from(this.xhrBreakpoints)
  }

  /**
   * Sets regex patterns for scripts to blackbox (skip when stepping).
   * Blackboxed scripts are hidden from the call stack and stepped over automatically.
   * Useful for ignoring framework/library code during debugging.
   *
   * @param options - Options
   * @param options.patterns - Array of regex patterns to match script URLs
   *
   * @example
   * ```ts
   * // Skip all node_modules
   * await dbg.setBlackboxPatterns({ patterns: ['node_modules'] })
   *
   * // Skip React and other frameworks
   * await dbg.setBlackboxPatterns({
   *   patterns: [
   *     'node_modules/react',
   *     'node_modules/react-dom',
   *     'node_modules/next',
   *     'webpack://',
   *   ]
   * })
   *
   * // Skip all third-party scripts
   * await dbg.setBlackboxPatterns({ patterns: ['^https://cdn\\.'] })
   *
   * // Clear all blackbox patterns
   * await dbg.setBlackboxPatterns({ patterns: [] })
   * ```
   */
  async setBlackboxPatterns({ patterns }: { patterns: string[] }): Promise<void> {
    await this.enable()
    this.blackboxPatterns = patterns
    await this.cdp.send('Debugger.setBlackboxPatterns', { patterns })
  }

  /**
   * Adds a single regex pattern to the blackbox list.
   *
   * @param options - Options
   * @param options.pattern - Regex pattern to match script URLs
   *
   * @example
   * ```ts
   * await dbg.addBlackboxPattern({ pattern: 'node_modules/lodash' })
   * await dbg.addBlackboxPattern({ pattern: 'node_modules/axios' })
   * ```
   */
  async addBlackboxPattern({ pattern }: { pattern: string }): Promise<void> {
    await this.enable()
    if (!this.blackboxPatterns.includes(pattern)) {
      this.blackboxPatterns.push(pattern)
      await this.cdp.send('Debugger.setBlackboxPatterns', { patterns: this.blackboxPatterns })
    }
  }

  /**
   * Removes a pattern from the blackbox list.
   *
   * @param options - Options
   * @param options.pattern - The exact pattern string to remove
   */
  async removeBlackboxPattern({ pattern }: { pattern: string }): Promise<void> {
    await this.enable()
    this.blackboxPatterns = this.blackboxPatterns.filter((p) => p !== pattern)
    await this.cdp.send('Debugger.setBlackboxPatterns', { patterns: this.blackboxPatterns })
  }

  /**
   * Returns the current list of blackbox patterns.
   */
  listBlackboxPatterns(): string[] {
    return [...this.blackboxPatterns]
  }

  // -------------------------------------------------------------------------
  // M4 additions (runtime-debug / trace lane). All additive — none of the
  // existing methods change behaviour.
  // -------------------------------------------------------------------------

  /**
   * Set a non-pausing logpoint: a conditional breakpoint whose condition logs a
   * tagged, JSON-serialised expression and then evaluates to `false`, so it never
   * pauses execution. Drain the emitted `[[logpoint:TAG]] <json>` lines from the
   * page console stream (see `readLogpoints`).
   *
   * The generated condition is VERIFIED non-pausing before it is sent (see
   * `buildLogpointCondition` / `verifyNonPausingCondition`): a malformed or hostile
   * `expr` — a stray `)`, an injected statement, a `debugger` — is refused with an
   * error instead of being installed as a breakpoint that pauses the page.
   *
   * @returns The breakpoint id (remove with `deleteBreakpoint`).
   * @throws Error when `expr` cannot be assembled into a provably non-pausing condition.
   *
   * @example
   * ```ts
   * await dbg.setLogpoint({ file: 'app.js', line: 42, expr: 'state.total', tag: 'total' })
   * ```
   */
  async setLogpoint({
    file,
    line,
    expr,
    tag,
    maxPayload,
    requireBinding = true,
  }: {
    file: string
    line: number
    expr: string
    tag?: string
    /** Cap on the JSON payload, applied in the page. Over-cap payloads are logged
     *  as `{"__playwriter_logpoint_truncated":N,"head":"…"}` so the cut is visible. */
    maxPayload?: number
    /** Defaults TRUE here — see `setBreakpoint`. Pass `false` only to arm a logpoint for
     *  a script that has not loaded yet, accepting that it may never bind. */
    requireBinding?: boolean
  }): Promise<string> {
    const condition = buildLogpointCondition({ tag, expr, maxPayload })
    const check = verifyNonPausingCondition(condition)
    if (!check.nonPausing) {
      throw new Error(
        `refusing to arm a logpoint at ${file}:${line}: the generated condition is not provably non-pausing ` +
          `(${check.problems.join('; ')}). \`expr\` must be a single JS EXPRESSION — no statements, no \`debugger\`, ` +
          `balanced parens. Got expr: ${JSON.stringify(expr)}`,
      )
    }
    return this.setBreakpoint({ file, line, condition, requireBinding })
  }

  /**
   * Resolve a script URL to its source. Maps url -> scriptId via the parsed-script
   * index (exact match first, then a substring match), then fetches the source.
   * Returns null when no script matches or the source is unavailable.
   *
   * @example
   * ```ts
   * const src = await dbg.getScriptSourceByUrl({ url: 'app.js' })
   * // { url, scriptId, source }
   * ```
   */
  async getScriptSourceByUrl({ url }: { url: string }): Promise<{ url: string; scriptId: string; source: string } | null> {
    await this.enable()
    let match: ScriptInfo | undefined
    for (const s of this.scripts.values()) {
      if (s.url === url) {
        match = s
        break
      }
    }
    if (!match) {
      for (const s of this.scripts.values()) {
        if (s.url.includes(url) || url.includes(s.url)) {
          match = s
          break
        }
      }
    }
    if (!match) return null
    try {
      const { scriptSource } = await this.cdp.send('Debugger.getScriptSource', { scriptId: match.scriptId })
      return { url: match.url, scriptId: match.scriptId, source: scriptSource }
    } catch {
      return null
    }
  }

  /**
   * Read EVERY paused call frame (not just the top one) with its local/closure
   * scopes resolved to plain values. Unlike `inspectLocalVariables` this walks the
   * whole stack and keeps values (large strings/objects are capped, never dropped).
   * `this` is surfaced separately per frame. Only valid while paused.
   *
   * Values come from `readRemoteObject`, so a nested number stays a number: CDP's
   * `PropertyPreview.value` is a string for EVERY type and the real type is in
   * `type`/`subtype`. Whatever the browser's preview limits cut is listed in
   * `overflowedContainers`/`cappedValues` rather than being baked into the value.
   *
   * @throws Error if the debugger is not paused.
   */
  async getCallFrames(): Promise<CallFrameInfo[]> {
    await this.enable()
    if (!this.paused || this.currentCallFrames.length === 0) {
      throw new Error('Debugger is not paused at a breakpoint')
    }

    const frames: CallFrameInfo[] = []
    for (const frame of this.currentCallFrames) {
      const scopeChain: ScopeVars[] = []
      const accounting = newPreviewAccounting()
      for (const scope of frame.scopeChain) {
        // Skip the global scope (huge, low signal); keep local/closure/block/catch.
        if (scope.type === 'global') continue
        if (!scope.object.objectId) continue
        const variables: Record<string, unknown> = {}
        try {
          const props = await this.cdp.send('Runtime.getProperties', {
            objectId: scope.object.objectId,
            ownProperties: true,
            accessorPropertiesOnly: false,
            generatePreview: true,
          })
          for (const prop of props.result) {
            if (prop.value) {
              variables[prop.name] = readRemoteObject(prop.value, { path: prop.name, accounting })
            }
          }
        } catch {
          // A scope we cannot read is skipped rather than failing the whole frame.
        }
        scopeChain.push({ type: scope.type, variables })
      }
      frames.push({
        functionName: frame.functionName || '(anonymous)',
        url: frame.url,
        location: { line: frame.location.lineNumber + 1, column: frame.location.columnNumber ?? 0 },
        this: frame.this ? readRemoteObject(frame.this, { path: 'this', accounting }) : undefined,
        scopeChain,
        cappedValues: accounting.cappedStrings,
        overflowedContainers: accounting.overflowed,
      })
    }
    return frames
  }

  /**
   * Convenience: arm an entry logpoint that logs a function's `arguments` every
   * time it is called, tagged so the caller can drain hits from the console log
   * stream (`readLogpoints`). Best-effort: locates the function body in the script
   * source by name. `maxHits` is advisory (the reader caps output).
   */
  async captureArgsAt({ file, fn, maxHits }: { file: string; fn: string; maxHits?: number }): Promise<CaptureArgsHandle> {
    await this.enable()
    const tag = `args:${fn}`
    const src = await this.getScriptSourceByUrl({ url: file })
    if (!src) {
      return { breakpointId: null, tag, file, fn, line: null, note: `no script found for url "${file}"` }
    }
    const line = this.findFunctionEntryLine(src.source, fn)
    if (line == null) {
      return { breakpointId: null, tag, file: src.url, fn, line: null, note: `function "${fn}" not found in ${src.url}` }
    }
    const breakpointId = await this.setLogpoint({
      file: src.url,
      line,
      expr: 'Array.prototype.slice.call(arguments)',
      tag,
    })
    return {
      breakpointId,
      tag,
      file: src.url,
      fn,
      line,
      note: `entry logpoint armed at ${src.url}:${line}; drain hits from the console log stream (tag "${tag}", maxHits=${maxHits ?? 'unbounded'})`,
    }
  }

  private findFunctionEntryLine(source: string, fn: string): number | null {
    const esc = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const lines = source.split('\n')
    const patterns = [
      new RegExp(`function\\s*\\*?\\s+${esc}\\b`),
      new RegExp(`\\b${esc}\\s*=\\s*(async\\s+)?function\\b`),
      new RegExp(`\\b${esc}\\s*=\\s*(async\\s*)?\\([^)]*\\)\\s*=>`),
      new RegExp(`\\b${esc}\\s*=\\s*(async\\s*)?[A-Za-z_$][\\w$]*\\s*=>`),
      new RegExp(`\\b${esc}\\s*\\([^)]*\\)\\s*{`),
    ]
    for (let i = 0; i < lines.length; i++) {
      if (patterns.some((p) => p.test(lines[i]))) {
        // Set the logpoint on the first body line so `arguments` is in scope.
        for (let j = i; j < Math.min(lines.length, i + 6); j++) {
          if (lines[j].includes('{')) {
            return Math.min(lines.length, j + 2)
          }
        }
        return i + 1
      }
    }
    return null
  }

  // `evaluate()`'s reader. It walks two levels of Runtime.getProperties (real
  // RemoteObjects, so primitives were never stringified the way previews are), but
  // its LEAF conversion fell back to `description` — turning NaN, ±Infinity, BigInt
  // and symbols into ordinary-looking strings. Leaves now go through
  // `readRemoteObject`, which reconstructs from `type`.
  private async processRemoteObject(obj: Protocol.Runtime.RemoteObject): Promise<unknown> {
    if (obj.type === 'undefined') {
      return undefined
    }

    if (obj.value !== undefined) {
      return obj.value
    }

    if (obj.type === 'object' && obj.objectId) {
      try {
        const props = await this.cdp.send('Runtime.getProperties', {
          objectId: obj.objectId,
          ownProperties: true,
          accessorPropertiesOnly: false,
          generatePreview: true,
        })

        const result: Record<string, unknown> = {}
        for (const prop of props.result) {
          if (prop.value) {
            if (prop.value.type === 'object' && prop.value.objectId && prop.value.subtype !== 'null') {
              try {
                const nestedProps = await this.cdp.send('Runtime.getProperties', {
                  objectId: prop.value.objectId,
                  ownProperties: true,
                  accessorPropertiesOnly: false,
                  generatePreview: true,
                })
                const nestedObj: Record<string, unknown> = {}
                for (const nestedProp of nestedProps.result) {
                  if (nestedProp.value) {
                    nestedObj[nestedProp.name] = readRemoteObject(nestedProp.value, { path: `${prop.name}.${nestedProp.name}` })
                  }
                }
                result[prop.name] = nestedObj
              } catch {
                result[prop.name] = readRemoteObject(prop.value, { path: prop.name })
              }
            } else {
              result[prop.name] = readRemoteObject(prop.value, { path: prop.name })
            }
          }
        }
        return result
      } catch {
        return readRemoteObject(obj)
      }
    }

    return readRemoteObject(obj)
  }
}
