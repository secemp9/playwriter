# Debugger API Reference

## Types

```ts
import type { ICDPSession } from './cdp-session.js';
import type { Protocol } from 'devtools-protocol';
export interface BreakpointInfo {
    id: string;
    file: string;
    line: number;
    /** The condition, if any. A logpoint's condition is verified non-pausing. */
    condition?: string;
    /** True when the condition was proven never to evaluate truthy (a logpoint). */
    nonPausing: boolean;
    /**
     * Whether V8 actually BOUND the breakpoint to a location in a loaded script.
     *
     * `Debugger.setBreakpointByUrl` returns a `breakpointId` unconditionally — measured:
     * a URL no script has, and a line past the end of a real script, both come back with
     * an id and an EMPTY `locations` array. The id alone therefore proves nothing, and an
     * unbound logpoint that never fires reads exactly like a code path that never ran.
     */
    bound: boolean;
    /** The script locations V8 resolved. Empty means `bound: false`. */
    resolvedLocations: Array<{
        scriptId: string;
        url: string;
        lineNumber: number;
        columnNumber?: number;
    }>;
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
export declare function buildBreakpointUrlRegex(file: string): string;
export interface LocationInfo {
    url: string;
    lineNumber: number;
    columnNumber: number;
    callstack: Array<{
        functionName: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
    }>;
    sourceContext: string;
}
/**
 * What the expression threw. PRESENT ONLY when it threw, so a caller cannot read a
 * failed evaluation as a successful one — the whole point of this field's existence.
 */
export interface EvaluateThrow {
    /** `Error: boom` — the exception's own description, not a paraphrase. */
    message: string;
    /** `Error`, `TypeError`, `ReferenceError`… Absent when the thrown value is not an object. */
    className?: string;
    /** The stack V8 attached to the thrown value, when it carried one. */
    stack?: string;
    /** V8's own summary line, e.g. `Uncaught`. */
    text: string;
    /** 0-based, as CDP sends them; only meaningful for parse/compile failures. */
    lineNumber?: number;
    columnNumber?: number;
}
export interface EvaluateResult {
    /** The completion value. `undefined` when `threw` is set — read `threw` first. */
    value: unknown;
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
    threw?: EvaluateThrow;
}
export interface ScriptInfo {
    scriptId: string;
    url: string;
}
/** One resolved scope in a paused call frame, with its variables read eagerly. */
export interface ScopeVars {
    type: string;
    variables: Record<string, unknown>;
}
/**
 * A single paused call frame. Unlike `inspectLocalVariables` (TOP frame only)
 * this reads EVERY frame's local/closure scopes. Both keep values (large ones
 * capped, not dropped). Only valid while paused.
 */
export interface CallFrameInfo {
    functionName: string;
    url: string;
    location: {
        line: number;
        column: number;
    };
    this?: unknown;
    scopeChain: ScopeVars[];
    /** `"<path>: <reason>"` for every string capped in this frame. */
    cappedValues: string[];
    /** `"<path>: <reason>"` for every container the BROWSER cut short in this frame.
     *  Values keep their real shape; the accounting lives here instead. */
    overflowedContainers: string[];
}
/** Handle returned by `captureArgsAt` — the caller drains hits from the log stream. */
export interface CaptureArgsHandle {
    breakpointId: string | null;
    tag: string;
    file: string;
    fn: string;
    line: number | null;
    note: string;
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
    variables: Record<string, unknown>;
    frame: {
        functionName: string;
        url: string;
        line: number;
        column: number;
        /** Always 0 — this is the TOP frame only. Use `getCallFrames()` for the stack. */
        index: 0;
        totalFrames: number;
    };
    scopes: Array<{
        type: string;
        variableCount: number;
        shadowed: string[];
        unreadable: boolean;
    }>;
    /** `"<path>: <reason>"` for every string value that was capped. */
    cappedValues: string[];
    /** `"<path>: <reason>"` for every container the BROWSER cut short. The value's own
     *  shape is never altered to say so — an array does not grow a marker element. */
    overflowedContainers: string[];
    /** Stated limits, so a caller never mistakes a limit for an absence. */
    limits: {
        topFrameOnly: true;
        globalScopeSkipped: boolean;
        maxValueLength: number;
        note: string;
    };
}
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
    overflowed: string[];
    /** Strings capped, by us at MAX_CAP_LENGTH or by V8's 100-char preview cap. */
    cappedStrings: string[];
}
export declare function newPreviewAccounting(): PreviewReadAccounting;
interface ReadOpts {
    path?: string;
    accounting?: PreviewReadAccounting;
    depth?: number;
    maxDepth?: number;
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
export declare function readRemoteObject(value: Protocol.Runtime.RemoteObject, opts?: ReadOpts): unknown;
export declare function readObjectPreview(preview: Protocol.Runtime.ObjectPreview, opts?: ReadOpts): unknown;
/**
 * Reconstruct a thrown exception from CDP's `ExceptionDetails`.
 *
 * The thrown value arrives as a RemoteObject that is NOT subject to `returnByValue`, so
 * its `description` is the real `Error: message\n    at …` text — the only place the
 * message survives when the caller asked for values by value.
 */
export declare function readExceptionDetails(details: Protocol.Runtime.ExceptionDetails): EvaluateThrow;
/** Default cap on a logpoint's JSON payload, applied IN the page before logging. */
export declare const LOGPOINT_PAYLOAD_MAX = 2000;
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
export declare function buildLogpointCondition({ tag, expr, maxPayload, }: {
    tag?: string;
    expr: string;
    maxPayload?: number;
}): string;
export interface NonPausingCheck {
    nonPausing: boolean;
    problems: string[];
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
export declare function verifyNonPausingCondition(condition: string): NonPausingCheck;
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
export declare class Debugger {
    private cdp;
    private debuggerEnabled;
    private paused;
    private currentCallFrames;
    private breakpoints;
    private scripts;
    private xhrBreakpoints;
    private blackboxPatterns;
    private nonPausingOnlyDepth;
    private nonPausingOnlyReason;
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
    constructor({ cdp }: {
        cdp: ICDPSession;
    });
    private setupEventListeners;
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
    enable(): Promise<void>;
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
    setBreakpoint({ file, line, condition, requireBinding, }: {
        file: string;
        line: number;
        condition?: string;
        /**
         * Refuse to report success unless V8 bound the breakpoint to a real location.
         *
         * Default `false`, because arming a breakpoint BEFORE the script loads is a
         * legitimate use (it binds on `scriptParsed`), and throwing there would break it.
         * `setLogpoint` defaults it to `true`: a logpoint is a MEASUREMENT, and an unbound
         * one produces no hits, which is indistinguishable from a code path that never ran.
         */
        requireBinding?: boolean;
    }): Promise<string>;
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
    runNonPausingOnly<T>(fn: () => Promise<T> | T, { reason }?: {
        reason?: string;
    }): Promise<T>;
    /** True while inside `runNonPausingOnly`. */
    isNonPausingOnly(): boolean;
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
    deleteBreakpoint({ breakpointId }: {
        breakpointId: string;
    }): Promise<void>;
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
    listBreakpoints(): BreakpointInfo[];
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
    inspectLocalVariables(): Promise<LocalVariablesResult>;
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
    inspectGlobalVariables(): Promise<string[]>;
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
    evaluate({ expression }: {
        expression: string;
    }): Promise<EvaluateResult>;
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
    getLocation(): Promise<LocationInfo>;
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
    stepOver(): Promise<void>;
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
    stepInto(): Promise<void>;
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
    stepOut(): Promise<void>;
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
    resume(): Promise<void>;
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
    isPaused(): boolean;
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
    setPauseOnExceptions({ state }: {
        state: 'none' | 'uncaught' | 'all';
    }): Promise<void>;
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
    listScripts({ search }?: {
        search?: string;
    }): Promise<ScriptInfo[]>;
    setXHRBreakpoint({ url }: {
        url: string;
    }): Promise<void>;
    removeXHRBreakpoint({ url }: {
        url: string;
    }): Promise<void>;
    listXHRBreakpoints(): string[];
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
    setBlackboxPatterns({ patterns }: {
        patterns: string[];
    }): Promise<void>;
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
    addBlackboxPattern({ pattern }: {
        pattern: string;
    }): Promise<void>;
    /**
     * Removes a pattern from the blackbox list.
     *
     * @param options - Options
     * @param options.pattern - The exact pattern string to remove
     */
    removeBlackboxPattern({ pattern }: {
        pattern: string;
    }): Promise<void>;
    /**
     * Returns the current list of blackbox patterns.
     */
    listBlackboxPatterns(): string[];
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
    setLogpoint({ file, line, expr, tag, maxPayload, requireBinding, }: {
        file: string;
        line: number;
        expr: string;
        tag?: string;
        /** Cap on the JSON payload, applied in the page. Over-cap payloads are logged
         *  as `{"__playwriter_logpoint_truncated":N,"head":"…"}` so the cut is visible. */
        maxPayload?: number;
        /** Defaults TRUE here — see `setBreakpoint`. Pass `false` only to arm a logpoint for
         *  a script that has not loaded yet, accepting that it may never bind. */
        requireBinding?: boolean;
    }): Promise<string>;
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
    getScriptSourceByUrl({ url }: {
        url: string;
    }): Promise<{
        url: string;
        scriptId: string;
        source: string;
    } | null>;
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
    getCallFrames(): Promise<CallFrameInfo[]>;
    /**
     * Convenience: arm an entry logpoint that logs a function's `arguments` every
     * time it is called, tagged so the caller can drain hits from the console log
     * stream (`readLogpoints`). Best-effort: locates the function body in the script
     * source by name. `maxHits` is advisory (the reader caps output).
     */
    captureArgsAt({ file, fn, maxHits }: {
        file: string;
        fn: string;
        maxHits?: number;
    }): Promise<CaptureArgsHandle>;
    private findFunctionEntryLine;
    private processRemoteObject;
}
export {};
```

## Examples

```ts
import { state, getCDPSession, createDebugger, console } from './debugger-examples-types.js'

// Example: List available scripts and set a breakpoint
async function listScriptsAndSetBreakpoint() {
  const cdp = await getCDPSession({ page: state.page })
  const dbg = createDebugger({ cdp })
  await dbg.enable()

  const scripts = await dbg.listScripts({ search: 'app' })
  console.log(scripts)

  if (scripts.length > 0) {
    const bpId = await dbg.setBreakpoint({ file: scripts[0].url, line: 100 })
    console.log('Breakpoint set:', bpId)
  }
}

// Example: Inspect state when paused at a breakpoint
async function inspectWhenPaused() {
  const cdp = await getCDPSession({ page: state.page })
  const dbg = createDebugger({ cdp })
  await dbg.enable()

  if (dbg.isPaused()) {
    const loc = await dbg.getLocation()
    console.log('Paused at:', loc.url, 'line', loc.lineNumber)
    console.log('Source:', loc.sourceContext)

    const vars = await dbg.inspectLocalVariables()
    console.log('Variables:', vars)

    const result = await dbg.evaluate({ expression: 'myVar.length' })
    console.log('myVar.length =', result.value)

    await dbg.stepOver()
  }
}

// Example: Step through code
async function stepThroughCode() {
  const cdp = await getCDPSession({ page: state.page })
  const dbg = createDebugger({ cdp })
  await dbg.enable()

  await dbg.setBreakpoint({ file: 'https://example.com/app.js', line: 42 })

  if (dbg.isPaused()) {
    await dbg.stepOver()
    await dbg.stepInto()
    await dbg.stepOut()
    await dbg.resume()
  }
}

// Example: Cleanup all breakpoints
async function cleanupBreakpoints() {
  const cdp = await getCDPSession({ page: state.page })
  const dbg = createDebugger({ cdp })

  const breakpoints = dbg.listBreakpoints()
  for (const bp of breakpoints) {
    await dbg.deleteBreakpoint({ breakpointId: bp.id })
  }
}

export { listScriptsAndSetBreakpoint, inspectWhenPaused, stepThroughCode, cleanupBreakpoints }

```