import { codeFrameColumns } from '@babel/code-frame'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import type { SourceMapInput } from '@jridgewell/trace-mapping'
import type { Loc } from './static-analysis.js'
import type { ICDPSession } from './cdp-session.js'
import { ModelFacingError } from './probe-types.js'

export interface OriginalPosition {
  source: string | null
  line: number | null
  column: number | null
  name: string | null
}

export interface SourceMapResolver {
  originalPosition(pos: { line: number; column: number; source?: string }): OriginalPosition
  map: TraceMap
}

/**
 * Build a resolver that maps generated (bundled) positions back to author
 * source through a source map. Accepts a raw source-map JSON/string or an
 * existing TraceMap. Columns are 0-based throughout (matching TraceMap and
 * Babel AST loc.column).
 *
 * Pass `inner` to chain a second map (e.g. bundler map -> framework map) so the
 * position is resolved through both hops.
 */
export function makeSourceMapResolver(
  mapJsonOrConsumer: SourceMapInput | TraceMap,
  inner?: SourceMapResolver,
): SourceMapResolver {
  const map = mapJsonOrConsumer instanceof TraceMap ? mapJsonOrConsumer : new TraceMap(mapJsonOrConsumer)

  function originalPosition(pos: { line: number; column: number; source?: string }): OriginalPosition {
    const traced = originalPositionFor(map, { line: pos.line, column: pos.column })
    const result: OriginalPosition = {
      source: traced.source ?? null,
      line: traced.line ?? null,
      column: traced.column ?? null,
      name: (traced as any).name ?? null,
    }
    if (inner && result.line != null && result.column != null) {
      return inner.originalPosition({ line: result.line, column: result.column })
    }
    return result
  }

  return { originalPosition, map }
}

/**
 * Render an agent-facing culprit excerpt with a caret under `loc`. Language
 * agnostic (works for JS / CSS / HTML text). `loc.column` is 0-based (Babel /
 * TraceMap style) and converted to code-frame's 1-based column internally.
 */
export function renderCodeFrame({ code, loc, message }: { code: string; loc: Loc; message?: string }): string {
  const line = loc.line != null && Number.isFinite(loc.line) && loc.line >= 1 ? loc.line : 1
  const col = loc.column != null && Number.isFinite(loc.column) ? Math.max(0, loc.column + 1) : 1
  const hasEnd = loc.endLine != null && Number.isFinite(loc.endLine) && loc.endLine >= 1
    && loc.endColumn != null && Number.isFinite(loc.endColumn) && loc.endColumn >= 0
  return codeFrameColumns(
    code,
    {
      start: { line, column: col },
      end: hasEnd ? { line: loc.endLine!, column: Math.max(0, (loc.endColumn ?? 0) + 1) } : undefined,
    },
    { highlightCode: false, message },
  )
}

/**
 * A script or source map could not be loaded: a network failure, an HTTP error, a size bound or
 * a stalled transfer. The browser's network stack serves these loads, not the page's main
 * thread, so this is never evidence that the page itself is unresponsive.
 */
export class ResourceLoadError extends ModelFacingError {
  readonly url: string
  constructor(url: string, cause: string) {
    super(`Loading ${url} failed: ${cause}`)
    this.name = 'ResourceLoadError'
    this.url = url
  }
}

/** `step` of loading `url`, failing with a ResourceLoadError when it makes no progress for `timeoutMs`. */
async function loadStep<T>(promise: Promise<T>, timeoutMs: number, url: string, step: string): Promise<T> {
  const stalled = Promise.withResolvers<never>()
  const timer = setTimeout(() => stalled.reject(new ResourceLoadError(url, `${step} made no progress for ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([promise, stalled.promise])
  } catch (error) {
    if (error instanceof ResourceLoadError) throw error
    throw new ResourceLoadError(url, `${step} failed (${error instanceof Error ? error.message : String(error)})`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch a script or source map the way DevTools does: `Network.loadNetworkResource` on the
 * frame (its cookies and origin), streamed through `IO.read`. Measured: it produces no
 * `Network.requestWillBeSent` and no Playwright `request` event, so the page neither makes nor
 * sees the request. `data:` URLs are decoded locally. Every failure is a `ResourceLoadError`
 * naming the URL and the cause: a non-OK response, more than `maxBytes`, or a step (the
 * request, one chunk read) that makes no progress for `timeoutMs` — a stall bound, so a large
 * file that keeps streaming is never cut.
 */
export async function loadResourceText({
  cdp,
  frameId,
  url,
  maxBytes,
  timeoutMs,
}: {
  cdp: ICDPSession
  frameId: string
  url: string
  maxBytes: number
  timeoutMs: number
}): Promise<string> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma < 0) throw new ResourceLoadError(url.slice(0, 40), 'malformed data: URL')
    const header = url.slice(5, comma)
    const body = url.slice(comma + 1)
    return header.endsWith(';base64') ? Buffer.from(body, 'base64').toString('utf8') : decodeURIComponent(body)
  }
  const loaded = await loadStep(
    cdp.send('Network.loadNetworkResource', { frameId, url, options: { disableCache: false, includeCredentials: true } }),
    timeoutMs,
    url,
    'the request',
  )
  const resource = loaded.resource
  if (!resource.success || !resource.stream) {
    const status = resource.httpStatusCode ? `HTTP ${resource.httpStatusCode}` : 'no response'
    throw new ResourceLoadError(url, `${status}${resource.netErrorName ? ` ${resource.netErrorName}` : ''}`)
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await loadStep(cdp.send('IO.read', { handle: resource.stream, size: 1 << 20 }), timeoutMs, url, 'reading the body')
      const buffer = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'utf8')
      total += buffer.length
      if (total > maxBytes) throw new ResourceLoadError(url, `larger than ${maxBytes} bytes (the load bound)`)
      chunks.push(buffer)
      if (chunk.eof) break
    }
  } finally {
    cdp.send('IO.close', { handle: resource.stream }).catch(() => {})
  }
  if (resource.httpStatusCode && resource.httpStatusCode >= 400) throw new ResourceLoadError(url, `HTTP ${resource.httpStatusCode}`)
  return Buffer.concat(chunks).toString('utf8')
}
