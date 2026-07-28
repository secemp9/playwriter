import { codeFrameColumns } from '@babel/code-frame'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import type { SourceMapInput } from '@jridgewell/trace-mapping'
import type { Loc } from './static-analysis.js'

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
