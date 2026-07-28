import type { ICDPSession } from './cdp-session.js'
import type { Protocol } from 'devtools-protocol'

export interface BreakpointInfo {
  id: string
  file: string
  line: number
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

export interface EvaluateResult {
  value: unknown
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
 * A single paused call frame. Unlike `inspectLocalVariables` (top frame only,
 * heavily truncated) this reads EVERY frame's local/closure scopes and keeps the
 * values (large ones capped, not dropped). Only valid while paused.
 */
export interface CallFrameInfo {
  functionName: string
  url: string
  location: { line: number; column: number }
  this?: unknown
  scopeChain: ScopeVars[]
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

// Cap for large scope/logpoint values: keep the value, don't drop it.
const MAX_CAP_LENGTH = 10000

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
 * const vars = await dbg.inspectLocalVariables()
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
   * Enables the debugger and runtime domains. Called automatically by other methods.
   * Also resumes execution if the target was started with --inspect-brk.
   *
   * @example
   * ```ts
   * await dbg.enable()
   * ```
   */
  async enable(): Promise<void> {
    if (this.debuggerEnabled) {
      return
    }
    await this.cdp.send('Debugger.disable')
    await this.cdp.send('Runtime.disable')
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
    await this.cdp.send('Runtime.enable')
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
  async setBreakpoint({ file, line, condition }: { file: string; line: number; condition?: string }): Promise<string> {
    await this.enable()

    const response = await this.cdp.send('Debugger.setBreakpointByUrl', {
      lineNumber: line - 1,
      urlRegex: file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      columnNumber: 0,
      condition,
    })

    this.breakpoints.set(response.breakpointId, { id: response.breakpointId, file, line })
    return response.breakpointId
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
   * Inspects local variables in the current call frame.
   * Must be paused at a breakpoint. String values over 1000 chars are truncated.
   * Use evaluate() for full control over reading specific values.
   *
   * @returns Record of variable names to values
   * @throws Error if not paused or no active call frames
   *
   * @example
   * ```ts
   * const vars = await dbg.inspectLocalVariables()
   * // { myVar: 'hello', count: 42 }
   * ```
   */
  async inspectLocalVariables(): Promise<Record<string, unknown>> {
    await this.enable()

    if (!this.paused || this.currentCallFrames.length === 0) {
      throw new Error('Debugger is not paused at a breakpoint')
    }

    const frame = this.currentCallFrames[0]
    const result: Record<string, unknown> = {}

    for (const scopeObj of frame.scopeChain) {
      if (scopeObj.type === 'global') {
        continue
      }

      if (!scopeObj.object.objectId) {
        continue
      }

      const objProperties = await this.cdp.send('Runtime.getProperties', {
        objectId: scopeObj.object.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: true,
      })

      for (const prop of objProperties.result) {
        if (prop.value && prop.configurable) {
          result[prop.name] = this.formatPropertyValue(prop.value)
        }
      }
    }

    return result
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
   * @param options - Options
   * @param options.expression - JavaScript expression to evaluate
   * @returns The result value
   *
   * @example
   * ```ts
   * // When paused, can access local variables:
   * const result = await dbg.evaluate({ expression: 'localVar + 1' })
   *
   * // Read a large string that would be truncated in inspectLocalVariables:
   * const full = await dbg.evaluate({ expression: 'largeStringVar' })
   * ```
   */
  async evaluate({ expression }: { expression: string }): Promise<EvaluateResult> {
    await this.enable()

    const wrappedExpression = `
      try {
        ${expression}
      } catch (e) {
        e;
      }
    `

    let response: Protocol.Debugger.EvaluateOnCallFrameResponse | Protocol.Runtime.EvaluateResponse

    if (this.paused && this.currentCallFrames.length > 0) {
      const frame = this.currentCallFrames[0]
      response = await this.cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frame.callFrameId,
        expression: wrappedExpression,
        objectGroup: 'console',
        includeCommandLineAPI: true,
        silent: false,
        returnByValue: true,
        generatePreview: true,
      })
    } else {
      response = await this.cdp.send('Runtime.evaluate', {
        expression: wrappedExpression,
        objectGroup: 'console',
        includeCommandLineAPI: true,
        silent: false,
        returnByValue: true,
        generatePreview: true,
        awaitPromise: true,
      })
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
   *   const vars = await dbg.inspectLocalVariables()
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
   * @returns The breakpoint id (remove with `deleteBreakpoint`).
   *
   * @example
   * ```ts
   * await dbg.setLogpoint({ file: 'app.js', line: 42, expr: 'state.total', tag: 'total' })
   * ```
   */
  async setLogpoint({ file, line, expr, tag }: { file: string; line: number; expr: string; tag?: string }): Promise<string> {
    const t = tag ?? 'lp'
    const condition = '(console.log("[[logpoint:' + t + ']] "+JSON.stringify((' + expr + '))),false)'
    return this.setBreakpoint({ file, line, condition })
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
            if (prop.value) variables[prop.name] = this.capRemoteValue(prop.value)
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
        this: frame.this ? this.capRemoteValue(frame.this) : undefined,
        scopeChain,
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

  // Read a RemoteObject into a plain, cycle-free value keeping content (one
  // preview level for objects/arrays) and capping only very large strings.
  private capRemoteValue(value: Protocol.Runtime.RemoteObject): unknown {
    if (value.type === 'function') return '[function]'
    if (value.subtype === 'null') return null
    if (value.type === 'undefined') return undefined
    if (value.value !== undefined) return this.capString(value.value)
    if (value.type === 'object') {
      const preview = value.preview
      if (preview) {
        const obj: Record<string, unknown> = {}
        for (const p of preview.properties ?? []) {
          obj[p.name] = p.value !== undefined ? this.capString(p.value) : `[${p.type}]`
        }
        if (preview.overflow) obj['…'] = '[more]'
        return value.subtype === 'array' ? Object.values(obj) : obj
      }
      return value.description ?? `[${value.subtype || value.type}]`
    }
    return value.description ?? `[${value.type}]`
  }

  private capString(value: unknown): unknown {
    if (typeof value === 'string' && value.length > MAX_CAP_LENGTH) {
      return value.slice(0, MAX_CAP_LENGTH) + `... (${value.length} chars)`
    }
    return value
  }

  private truncateValue(value: unknown): unknown {
    if (typeof value === 'string' && value.length > 1000) {
      return value.slice(0, 1000) + `... (${value.length} chars)`
    }
    return value
  }

  private formatPropertyValue(value: Protocol.Runtime.RemoteObject): unknown {
    if (value.type === 'object' && value.subtype !== 'null') {
      return `[${value.subtype || value.type}]`
    }
    if (value.type === 'function') {
      return '[function]'
    }
    if (value.value !== undefined) {
      return this.truncateValue(value.value)
    }
    return `[${value.type}]`
  }

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
                    nestedObj[nestedProp.name] =
                      nestedProp.value.value !== undefined
                        ? nestedProp.value.value
                        : nestedProp.value.description || `[${nestedProp.value.subtype || nestedProp.value.type}]`
                  }
                }
                result[prop.name] = nestedObj
              } catch {
                result[prop.name] = prop.value.description || `[${prop.value.subtype || prop.value.type}]`
              }
            } else if (prop.value.type === 'function') {
              result[prop.name] = '[function]'
            } else if (prop.value.value !== undefined) {
              result[prop.name] = prop.value.value
            } else {
              result[prop.name] = `[${prop.value.type}]`
            }
          }
        }
        return result
      } catch {
        return obj.description || `[${obj.subtype || obj.type}]`
      }
    }

    return obj.description || `[${obj.type}]`
  }
}
