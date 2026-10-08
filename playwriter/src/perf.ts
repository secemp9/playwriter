/**
 * perf.ts — read-only performance instruments: `perf.vitals()`, `perf.metrics()`, `perf.trace.*`,
 * `perf.profile.*`, `pdf()`, and the SHIFT line of the action report.
 *
 * Nothing here reloads, injects or writes the page:
 *   - Web Vitals come from the page's own performance timeline, observed from playwriter's isolated
 *     world (perf-observers.ts). An entry Chrome never recorded is reported as unknown, with why —
 *     never by reloading to measure again (omp's vitals() reloads an adopted page without saying so).
 *   - `Performance.getMetrics`, `Tracing.*` + `IO.read`, and `Profiler.*` are sent on the page's own
 *     session; they measure the renderer and change nothing the page can see. Measured on Chrome 149
 *     headless and through the extension (chrome.debugger allows the Performance, Tracing, IO and
 *     Profiler domains): a 300 ms click handler shows as a 305 ms RunTask in the trace.
 *   - `Page.printToPDF` is the one the page CAN see: measured on Chrome 149, the page received
 *     `beforeprint`, its `matchMedia('print')` listeners fired (true, then false) and `afterprint`
 *     followed — exactly what a person's Ctrl+P → "Save as PDF" fires; no resize, no ResizeObserver
 *     callback. pdf() is therefore allowed in human mode, and its result says the page saw a print
 *     and whether its print handlers changed its content (read from the page's event journal).
 *
 * Every CDP command has a deadline. `Performance.enable` and `Profiler.enable` are never disabled:
 * the session is shared.
 */

import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import type { BrowserContext, Page } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { BrowserClock } from './browser-clock.js'
import type { ICDPSession } from './cdp-session.js'
import { withDeadline, type IsolatedWorld } from './isolated-world.js'
import { quote, type Observation } from './page-observe.js'
import type { PageProbe, PageProbes } from './page-probe.js'
import {
  PERF_NODES_FN,
  PERF_OBSERVERS_SOURCE,
  PERF_READ_EXPRESSION,
  type PerfEvent,
  type PerfInteraction,
  type PerfLoaf,
  type PerfNodeRequest,
  type PerfRead,
  type PerfRect,
  type PerfShift,
} from './perf-observers.js'
import { ModelFacingError } from './probe-types.js'
import type { ScopedFS } from './scoped-fs.js'

const CDP_TIMEOUT_MS = 5000
/** Chrome flushes the trace buffers after Tracing.end; a long trace takes a while. */
const TRACE_END_TIMEOUT_MS = 30_000
const IO_CHUNK_BYTES = 1 << 20

/**
 * web.dev's Core Web Vitals thresholds (https://web.dev/articles/vitals): at or under the first is
 * "good", over the second is "poor", in between "needs improvement". LCP/INP/FCP/TTFB in ms.
 */
const THRESHOLDS: Record<'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb', readonly [number, number]> = {
  lcp: [2500, 4000],
  inp: [200, 500],
  cls: [0.1, 0.25],
  fcp: [1800, 3000],
  ttfb: [800, 1800],
}

function rating(metric: keyof typeof THRESHOLDS, value: number): string {
  const [good, poor] = THRESHOLDS[metric]
  return value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor'
}

const ms = (value: number): string => `${Math.round(value)} ms`

/** The page a call reads: `options.page` when given (an open tab of this session), else the controlled page. */
function pageOption(options: unknown, deps: Pick<InstrumentDeps, 'context' | 'currentPage'>): Page {
  const page: unknown = typeof options === 'object' && options !== null ? Reflect.get(options, 'page') : undefined
  if (page === undefined) return deps.currentPage()
  const open = deps.context.pages().find((candidate) => candidate === page)
  if (!open || open.isClosed()) {
    throw new ModelFacingError('`page` must be an open tab of this session: state.page, or one of context.pages(). Nothing was run.')
  }
  return open
}

/** Refuses option keys the call does not know: a misspelt one would otherwise be ignored silently. */
function checkKeys(call: string, options: unknown, allowed: readonly string[]): void {
  if (options === undefined) return
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new ModelFacingError(`${call} takes an options object ({ ${allowed.join(', ')} }). Nothing was run.`)
  }
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new ModelFacingError(`${call} does not take ${unknown.map((key) => `\`${key}\``).join(', ')}; its options are { ${allowed.join(', ')} }. Nothing was run.`)
  }
}

/** A native dialog freezes the page: nothing in it answers until it is handled. */
function refuseWhileDialog(probe: PageProbe, call: string): void {
  const dialog = probe.dialogs.current()
  if (dialog?.handling !== 'agent') return
  throw new ModelFacingError(
    `${call}: a native ${dialog.type}("${dialog.message}") dialog is open and freezes the page, so it cannot be measured. ` +
      'Answer it first: act.dialog.accept() or act.dialog.dismiss(). Nothing was run.',
  )
}

/** Where a file may be written, resolved like the sandbox's fs (relative to the session folder). */
function outputPath(jail: ScopedFS, target: unknown, call: string, example: string): string {
  if (typeof target !== 'string' || target === '') {
    throw new ModelFacingError(`${call} needs \`path\`, the file to write, like ${example}. Nothing was run.`)
  }
  const resolved = jail.resolveAllowed(target)
  if (resolved === null) {
    throw new ModelFacingError(
      `${call}: ${target} is outside the folders this session may write to (${jail.allowedDirectories().join(', ')}). ` +
        `Pass a path inside one of them; a relative path is resolved from the session folder, like ${example}. Nothing was run.`,
    )
  }
  if (target.endsWith('/') || (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) {
    throw new ModelFacingError(`${call}: ${target} is a folder. Pass the path of the file to write, like ${example}. Nothing was run.`)
  }
  return resolved
}

/** Reads a CDP stream to its end (`IO.read`), then closes it. */
async function readStream(cdp: ICDPSession, handle: string, what: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  try {
    for (;;) {
      const chunk = await withDeadline(cdp.send('IO.read', { handle, size: IO_CHUNK_BYTES }), CDP_TIMEOUT_MS, `reading ${what}`)
      chunks.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data, 'utf8'))
      if (chunk.eof) break
    }
  } finally {
    await withDeadline(cdp.send('IO.close', { handle }), CDP_TIMEOUT_MS, `closing the stream of ${what}`)
  }
  return Buffer.concat(chunks)
}

/** The value printed above the call's result: the object stays inspectable, its echo is one line. */
function quiet<T extends object>(value: T, summary: string): T {
  Object.defineProperty(value, util.inspect.custom, { value: () => summary, enumerable: false })
  return value
}

// --- Web Vitals ------------------------------------------------------------------------------

/** One clock per main-frame world: entry times are the page's, report times this process's. */
const clocks = new WeakMap<IsolatedWorld, BrowserClock>()

interface TimelineRead {
  read: PerfRead
  /** An entry's time (ms since the document's time origin) on this process's clock. */
  toLocal: (startTime: number) => number
}

/**
 * The page's performance timeline as plain data. The observers are started first (once per
 * document; a no-op when the world's setup already ran them), so the first read of a page loaded
 * before playwriter attached still gets everything Chrome buffered.
 */
async function readTimeline(world: IsolatedWorld): Promise<TimelineRead> {
  await world.evaluate<boolean>(PERF_OBSERVERS_SOURCE, { what: 'starting the performance observers in the isolated world' })
  const sentAt = Date.now()
  const read = await world.evaluate<PerfRead | null>(PERF_READ_EXPRESSION, { what: "reading the page's performance timeline" })
  const receivedAt = Date.now()
  if (!read) {
    throw new ModelFacingError('The page navigated while its performance timeline was being read. Call it again once the new page has loaded.')
  }
  const clock = clocks.get(world) ?? new BrowserClock()
  clocks.set(world, clock)
  clock.roundTrip(sentAt, read.now, receivedAt)
  // `performance.now()` and `Date.now()` read together give the entry's wall time on the page's clock.
  return { read, toLocal: (startTime) => clock.toLocal(read.now - (read.perfNow - startTime)) }
}

/**
 * The nodes behind entries, each placed among `observation`'s refs, in `request`'s order:
 * `[12] button "Load offers"` for a listed element, `inside [12] …` for a node within one,
 * `p "Offers loaded" (page content, no ref)` for content outside every listed element.
 */
async function placeNodes(
  probes: PageProbes,
  page: Page,
  world: IsolatedWorld,
  observation: Observation,
  request: PerfNodeRequest,
): Promise<string[]> {
  const ids = await world.nodesReturnedBy([], PERF_NODES_FN, { args: request, what: 'finding the elements behind performance entries' })
  return await Promise.all(
    ids.map(async (id) => {
      if (id === null) return 'a node no longer on the page'
      const located = await probes.locateNode(page, observation, id)
      switch (located.kind) {
        case 'element': {
          const { element } = located
          const head = `[${element.ref}] ${element.role}${element.name ? ` ${quote(element.name, 60)}` : ''}`
          return located.exact ? head : `inside ${head}`
        }
        case 'content':
          return `${located.tag}${located.text ? ` ${quote(located.text, 60)}` : ''} (page content, no ref)`
        case 'gone':
          return 'a node no longer on the page'
      }
    }),
  )
}

/** How one layout-shift source moved, in words (viewport CSS px). */
function movement(previous: PerfRect, current: PerfRect): string {
  if (current.w === 0 && current.h === 0) return 'moved out of view'
  if (previous.w === 0 && previous.h === 0) return 'moved into view'
  const parts: string[] = []
  const dy = Math.round(current.y - previous.y)
  const dx = Math.round(current.x - previous.x)
  if (dy !== 0) parts.push(`moved ${dy > 0 ? 'down' : 'up'} ${Math.abs(dy)}px`)
  if (dx !== 0) parts.push(`moved ${dx > 0 ? 'right' : 'left'} ${Math.abs(dx)}px`)
  const dh = Math.round(current.h - previous.h)
  const dw = Math.round(current.w - previous.w)
  if (dh !== 0) parts.push(`${dh > 0 ? 'grew' : 'shrank'} ${Math.abs(dh)}px in height`)
  if (dw !== 0) parts.push(`${dw > 0 ? 'grew' : 'shrank'} ${Math.abs(dw)}px in width`)
  return parts.length > 0 ? parts.join(', ') : 'moved'
}

/** Sources listed per shift; the rest are counted. Chrome reports at most five per entry. */
const SOURCES_SHOWN = 3

/** `moved down 120px: [12] img "Hero", p "Intro" (page content, no ref) (+N more)` for one shift, with its placed nodes. */
function shiftSources(shift: PerfShift, placed: string[]): string {
  const byMovement = new Map<string, string[]>()
  shift.sources.slice(0, SOURCES_SHOWN).forEach((source, index) => {
    const how = movement(source.previous, source.current)
    byMovement.set(how, [...(byMovement.get(how) ?? []), placed[index]])
  })
  const more = shift.sources.length - SOURCES_SHOWN
  return `${[...byMovement].map(([how, nodes]) => `${how}: ${nodes.join(', ')}`).join('; ')}${more > 0 ? ` (+${more} more)` : ''}`
}

/**
 * CLS the way Chrome's web-vitals library defines it: shifts without recent input grouped in session
 * windows (each shift less than 1 s after the previous one, the window under 5 s long); CLS is the
 * largest window's sum.
 */
function largestSessionWindow(shifts: PerfShift[]): { value: number; shifts: PerfShift[] } {
  let best: { value: number; shifts: PerfShift[] } = { value: 0, shifts: [] }
  let current: { value: number; shifts: PerfShift[] } = { value: 0, shifts: [] }
  for (const shift of shifts.filter((entry) => !entry.hadRecentInput).sort((a, b) => a.startTime - b.startTime)) {
    const first = current.shifts[0]
    const last = current.shifts.at(-1)
    if (first && last && shift.startTime - last.startTime < 1000 && shift.startTime - first.startTime < 5000) {
      current = { value: current.value + shift.value, shifts: [...current.shifts, shift] }
    } else {
      current = { value: shift.value, shifts: [shift] }
    }
    if (current.value > best.value) best = current
  }
  return best
}

/** One interaction with web-vitals' INP attribution taken over its event entries. */
interface AttributedInteraction {
  id: number
  /** Its event types in the order they happened (`pointerdown/pointerup/click`). */
  name: string
  /** The longest event's start: when the input the interaction is measured from happened. */
  startTime: number
  /** The longest event's duration, which is the interaction's latency. */
  duration: number
  inputDelay: number
  processing: number
  presentation: number
  /** The events whose handlers ran 1 ms or more in the measured frame, with that time. */
  handlers: Array<{ name: string; ms: number }>
}

/** Chrome rounds event durations to 8 ms: entries whose next paint is this close share a frame. */
const SAME_FRAME_MS = 8

/**
 * web-vitals' INP attribution over an interaction's entries (grouped by interactionId). The longest
 * entry is the latency and its start is the input time; the entries painted in the same frame are
 * the ones it waited for (a pointerdown held before its pointerup paints a frame of its own).
 * inputDelay = first processingStart − start; processing = first processingStart → last
 * processingEnd; presentation = start + duration − last processingEnd.
 */
function attribute(interaction: PerfInteraction): AttributedInteraction | null {
  const events = [...interaction.events].sort((a, b) => a.startTime - b.startTime)
  const longest = events.reduce<PerfEvent | null>((best, event) => (best === null || event.duration > best.duration ? event : best), null)
  if (longest === null) return null
  const paint = longest.startTime + longest.duration
  const frame = events.filter((event) => Math.abs(event.startTime + event.duration - paint) <= SAME_FRAME_MS)
  const startTime = Math.min(...frame.map((event) => event.startTime))
  const processingStart = Math.min(...frame.map((event) => event.processingStart))
  const processingEnd = Math.max(...frame.map((event) => event.processingEnd))
  const end = Math.max(startTime + longest.duration, processingEnd)
  return {
    id: interaction.id,
    name: [...new Set(events.map((event) => event.name))].join('/'),
    startTime,
    duration: longest.duration,
    inputDelay: Math.max(processingStart - startTime, 0),
    processing: processingEnd - processingStart,
    presentation: end - processingEnd,
    handlers: frame.filter((event) => event.processingEnd - event.processingStart >= 1).map((event) => ({ name: event.name, ms: event.processingEnd - event.processingStart })),
  }
}

/**
 * INP the way web-vitals computes it: each interaction's longest event, then the 98th percentile —
 * the slowest one, skipping one per 50 interactions of the page (`performance.interactionCount`).
 */
function inpOf(interactions: AttributedInteraction[], interactionCount: number | null): AttributedInteraction | null {
  if (interactions.length === 0) return null
  const sorted = [...interactions].sort((a, b) => b.duration - a.duration)
  const skip = Math.floor((interactionCount ?? interactions.length) / 50)
  return sorted[Math.min(skip, sorted.length - 1)]
}

/** The longest script of a long animation frame, as `invoker → function (url char N) duration`. */
function loafScript(loaf: PerfLoaf): string {
  const script = [...loaf.scripts].sort((a, b) => b.duration - a.duration)[0]
  if (!script) return 'no script attributed by Chrome'
  const where = script.sourceURL ? ` (${script.sourceURL}${script.sourceCharPosition >= 0 ? ` char ${script.sourceCharPosition}` : ''})` : ''
  return `script ${script.invoker || script.invokerType || '(unnamed)'}${script.sourceFunctionName ? ` → ${script.sourceFunctionName}` : ''}${where} ${ms(script.duration)}`
}

export interface VitalMetric {
  ms?: number
  value?: number
  rating?: string
  /** Why the metric is unknown, when it is. */
  unknown?: string
}

export interface VitalsResult {
  url: string
  /** ms after the document started loading when playwriter began observing it. */
  trackingSince: number
  ttfb: VitalMetric
  fcp: VitalMetric
  lcp: VitalMetric & { element?: string; resource?: string }
  cls: VitalMetric & { shifts?: Array<{ at: number; value: number; moved: string }> }
  /** The INP interaction's web-vitals breakdown: input delay + processing + presentation = ms. */
  inp: VitalMetric & { interaction?: string; interactions?: number; inputDelayMs?: number; processingMs?: number; presentationMs?: number }
  longTasks: { count: number; longestMs: number | null }
  longAnimationFrames: Array<{ at: number; ms: number; blockingMs: number; script: string }>
  domContentLoaded: number | null
  load: number | null
  text: string
}

/** Long animation frames listed in vitals(); the rest are counted. */
const LOAFS_SHOWN = 5

async function vitals(deps: InstrumentDeps, page: Page): Promise<VitalsResult> {
  const probe = await deps.probes.get(page)
  refuseWhileDialog(probe, 'perf.vitals()')
  const world = probe.frames.main.world
  const { read } = await readTimeline(world)
  const window = largestSessionWindow(read.shifts)
  const interactions = read.interactions.map(attribute).filter((entry) => entry !== null)
  const inp = inpOf(interactions, read.interactionCount)
  const request: PerfNodeRequest = {
    lcp: read.lcp !== null,
    shifts: window.shifts.map((shift) => ({ id: shift.id, sources: Math.min(shift.sources.length, SOURCES_SHOWN) })),
    interactions: inp ? [inp.id] : [],
  }
  const observation = await deps.probes.observe(page, deps.context, {}, false)
  const placed = await placeNodes(deps.probes, page, world, observation, request)
  let cursor = 0
  const lcpElement = read.lcp ? placed[cursor++] : undefined
  const shiftLines = window.shifts.map((shift) => {
    const nodes = placed.slice(cursor, cursor + Math.min(shift.sources.length, SOURCES_SHOWN))
    cursor += nodes.length
    return { at: Math.round(shift.startTime), value: shift.value, moved: shiftSources(shift, nodes) }
  })
  const interactionTarget = placed[cursor]

  const lines: string[] = []
  const nav = read.navigation
  const trackingSince = Math.round(read.startedAt)
  const result: VitalsResult = {
    url: read.url,
    trackingSince,
    ttfb: {},
    fcp: {},
    lcp: {},
    cls: {},
    inp: {},
    longTasks: { count: read.longTasks.length, longestMs: read.longTasks.length ? Math.round(Math.max(...read.longTasks.map((task) => task.duration))) : null },
    longAnimationFrames: [],
    domContentLoaded: nav && nav.domContentLoaded > 0 ? Math.round(nav.domContentLoaded) : null,
    load: nav && nav.load > 0 ? Math.round(nav.load) : null,
    text: '',
  }
  lines.push(
    `VITALS  ${read.url} — read from the page's own performance timeline (nothing reloaded); times are ms after the document started loading; ` +
      `playwriter began observing it at ${ms(trackingSince)} (Chrome's buffers cover what came before)`,
  )

  if (nav) {
    const ttfb = Math.max(nav.responseStart - nav.activationStart, 0)
    result.ttfb = { ms: Math.round(ttfb), rating: rating('ttfb', ttfb) }
    lines.push(`  TTFB  ${ms(ttfb)} (${rating('ttfb', ttfb)})`)
  } else {
    result.ttfb = { unknown: 'the document has no navigation timing entry' }
    lines.push(`  TTFB  unknown: ${result.ttfb.unknown}`)
  }

  const hiddenBeforePaint = read.visibility.some((entry) => entry.name === 'hidden' && (read.fcp === null || entry.startTime <= read.fcp))
  if (read.fcp !== null) {
    result.fcp = { ms: Math.round(read.fcp), rating: rating('fcp', read.fcp) }
    lines.push(`  FCP   ${ms(read.fcp)} (${rating('fcp', read.fcp)})`)
  } else {
    result.fcp = {
      unknown: hiddenBeforePaint
        ? 'the page was hidden (a background tab or a minimised window) before it painted; Chrome records no paint timing for such a load'
        : 'the page has not painted any content yet',
    }
    lines.push(`  FCP   unknown: ${result.fcp.unknown}`)
  }

  if (read.lcp) {
    const lcp = read.lcp
    result.lcp = { ms: Math.round(lcp.startTime), rating: rating('lcp', lcp.startTime), element: lcpElement, ...(lcp.url ? { resource: lcp.url } : {}) }
    lines.push(
      `  LCP   ${ms(lcp.startTime)} (${rating('lcp', lcp.startTime)}) — ${lcpElement}${lcp.url ? ` · resource ${lcp.url}` : ''}` +
        (lcp.renderTime === 0 && lcp.loadTime > 0 ? ' (load time: the image is cross-origin without Timing-Allow-Origin, so Chrome hides its render time)' : ''),
    )
  } else {
    result.lcp = {
      unknown: read.unsupported.includes('largest-contentful-paint')
        ? 'this browser does not report largest-contentful-paint'
        : hiddenBeforePaint
          ? 'the page was hidden (a background tab or a minimised window) while it loaded; Chrome reports no LCP for such a load'
          : read.fcp === null
            ? 'the page has not painted any content yet'
            : `Chrome recorded no largest-contentful-paint entry for this document (playwriter began observing at ${ms(trackingSince)}; ` +
              "Chrome's buffer would have kept an earlier one)",
    }
    lines.push(`  LCP   unknown: ${result.lcp.unknown}`)
  }

  const counted = read.shifts.filter((shift) => !shift.hadRecentInput)
  if (read.unsupported.includes('layout-shift')) {
    result.cls = { unknown: 'this browser does not report layout-shift' }
    lines.push(`  CLS   unknown: ${result.cls.unknown}`)
  } else {
    const value = window.value
    result.cls = { value: Number(value.toFixed(4)), rating: rating('cls', value), shifts: shiftLines }
    const head =
      counted.length === 0
        ? '— no layout shift without recent input'
        : `— its largest burst: ${window.shifts.length} shift${window.shifts.length === 1 ? '' : 's'} of ${counted.length} without recent input`
    lines.push(`  CLS   ${value.toFixed(3)} (${rating('cls', value)}) ${head}`)
    for (const shift of shiftLines) lines.push(`        ${shift.value.toFixed(3)} at ${ms(shift.at)}: ${shift.moved}`)
    if (read.dropped.shifts > 0) lines.push(`        (${read.dropped.shifts} older shifts were dropped from playwriter's store: CLS is a lower bound)`)
  }

  const sinceTracking = read.interactionCount !== null && read.interactionsAtStart !== null ? read.interactionCount - read.interactionsAtStart : null
  if (read.unsupported.includes('event')) {
    result.inp = { unknown: 'this browser does not report event timing' }
    lines.push(`  INP   unknown: ${result.inp.unknown}`)
  } else if (inp) {
    const before = interactions.filter((entry) => entry.startTime < read.startedAt).length
    const handlers = inp.handlers.length > 0 ? ` (${inp.handlers.map((handler) => `${handler.name} ${ms(handler.ms)}`).join(', ')})` : ''
    const breakdown = `input delay ${ms(inp.inputDelay)}, processing ${ms(inp.processing)}${handlers}, presentation ${ms(inp.presentation)}`
    result.inp = {
      ms: Math.round(inp.duration),
      rating: rating('inp', inp.duration),
      interaction: `${inp.name} on ${interactionTarget}`,
      interactions: interactions.length,
      inputDelayMs: Math.round(inp.inputDelay),
      processingMs: Math.round(inp.processing),
      presentationMs: Math.round(inp.presentation),
    }
    lines.push(
      `  INP   ${ms(inp.duration)} (${rating('inp', inp.duration)}) over ${interactions.length} measured interaction${interactions.length === 1 ? '' : 's'}` +
        (before > 0 ? ` (${before} from before playwriter observed the page, kept by Chrome because they took 104 ms or more)` : '') +
        ` — ${inp.name} on ${interactionTarget}: ${breakdown}`,
    )
  } else if (sinceTracking !== null && sinceTracking > 0) {
    result.inp = { unknown: `under 16 ms: ${sinceTracking} interaction(s) since playwriter began observing, none took 16 ms or more (Chrome reports event timing from 16 ms)` }
    lines.push(`  INP   ${result.inp.unknown}`)
  } else {
    result.inp = { unknown: `no interaction (click, tap or key press) since playwriter began observing at ${ms(trackingSince)} — act on the page, then call perf.vitals() again` }
    lines.push(`  INP   unknown: ${result.inp.unknown}`)
  }

  const longest = result.longTasks.longestMs
  lines.push(
    `  LONG TASKS  ${read.longTasks.length}${longest !== null ? `, longest ${ms(longest)}` : ''}` + (read.dropped.longTasks > 0 ? ` (+${read.dropped.longTasks} older dropped)` : ''),
  )
  const loafs = [...read.loafs].sort((a, b) => b.duration - a.duration)
  result.longAnimationFrames = loafs.slice(0, LOAFS_SHOWN).map((loaf) => ({
    at: Math.round(loaf.startTime),
    ms: Math.round(loaf.duration),
    blockingMs: Math.round(loaf.blockingDuration),
    script: loafScript(loaf),
  }))
  if (read.unsupported.includes('long-animation-frame')) {
    lines.push('  LONG ANIMATION FRAMES  unknown: this browser does not report long-animation-frame')
  } else {
    lines.push(`  LONG ANIMATION FRAMES  ${read.loafs.length}${read.loafs.length > LOAFS_SHOWN ? ` (the ${LOAFS_SHOWN} longest listed)` : ''}`)
    for (const loaf of result.longAnimationFrames) lines.push(`        ${ms(loaf.ms)} at ${ms(loaf.at)} (blocking ${ms(loaf.blockingMs)}) — ${loaf.script}`)
  }
  if (result.domContentLoaded !== null || result.load !== null) {
    lines.push(`  DOMContentLoaded ${result.domContentLoaded === null ? 'not yet' : ms(result.domContentLoaded)} · load ${result.load === null ? 'not yet' : ms(result.load)}`)
  }
  result.text = lines.join('\n')
  return result
}

/** Layout shifts listed in one action report; the rest are counted. */
const SHIFTS_PER_REPORT = 3

/**
 * The SHIFT lines of an action report: layout shifts without recent input (the ones CLS counts,
 * content that moved by itself) since `since` (this process's clock), each with its moved nodes
 * placed among `after`'s refs. Shifts within 500 ms of an input are the input's own effect (Chrome's
 * `hadRecentInput`) and are not listed: what they changed is in the report's diff.
 */
export async function layoutShiftLines({
  probes,
  probe,
  page,
  after,
  since,
}: {
  probes: PageProbes
  probe: PageProbe
  page: Page
  after: Observation
  since: number
}): Promise<string[]> {
  // A native dialog freezes the page: its timeline cannot be read while the dialog is open, and the
  // report's DIALOG line says the page is blocked.
  if (probe.dialogs.current()) return []
  const world = probe.frames.main.world
  const { read, toLocal } = await readTimeline(world)
  const shifts = read.shifts.filter((shift) => !shift.hadRecentInput && toLocal(shift.startTime) >= since)
  if (shifts.length === 0) return []
  const listed = [...shifts].sort((a, b) => b.value - a.value).slice(0, SHIFTS_PER_REPORT).sort((a, b) => a.startTime - b.startTime)
  const placed = await placeNodes(probes, page, world, after, {
    lcp: false,
    shifts: listed.map((shift) => ({ id: shift.id, sources: Math.min(shift.sources.length, SOURCES_SHOWN) })),
    interactions: [],
  })
  let cursor = 0
  const lines = listed.map((shift) => {
    const nodes = placed.slice(cursor, cursor + Math.min(shift.sources.length, SOURCES_SHOWN))
    cursor += nodes.length
    const delay = (toLocal(shift.startTime) - since) / 1000
    return `${shift.value.toFixed(3)} — ${shiftSources(shift, nodes)} — content moved by itself ${delay.toFixed(1)}s after the action began (a layout shift)`
  })
  const rest = shifts.length - listed.length
  if (rest > 0) {
    const total = shifts.reduce((sum, shift) => sum + shift.value, 0)
    lines.push(`+${rest} more layout shifts (all together ${total.toFixed(3)}) — perf.vitals() lists CLS`)
  }
  return lines
}

// --- Metrics, trace, profile -----------------------------------------------------------------

/** Metric names that are monotonic timestamps in seconds; shown relative to NavigationStart. */
const TIMESTAMP_METRICS: Record<string, true> = { Timestamp: true, NavigationStart: true, DomContentLoaded: true, FirstMeaningfulPaint: true }

/**
 * When perf.metrics() first enabled the Performance domain on a tab's session. Measured on Chrome
 * 149: the counts and durations start at 0 with `Performance.enable` (LayoutCount 0 on a page that had
 * laid out) and a second enable does not reset them.
 */
const countingSince = new WeakMap<ICDPSession, number>()

async function metrics(deps: InstrumentDeps, page: Page): Promise<Record<string, number>> {
  const probe = await deps.probes.get(page)
  refuseWhileDialog(probe, 'perf.metrics()')
  await withDeadline(probe.cdp.send('Performance.enable'), CDP_TIMEOUT_MS, 'enabling the Performance domain')
  const since = countingSince.get(probe.cdp) ?? Date.now()
  countingSince.set(probe.cdp, since)
  const { metrics: list } = await withDeadline(probe.cdp.send('Performance.getMetrics'), CDP_TIMEOUT_MS, 'reading Performance.getMetrics')
  const values: Record<string, number> = {}
  for (const metric of list) values[metric.name] = metric.value
  const navigationStart = values.NavigationStart
  const shown = list.map((metric) => {
    // Performance.getMetrics reports durations in seconds.
    if (metric.name.endsWith('Duration') || metric.name === 'ThreadTime' || metric.name === 'ProcessTime') return `${metric.name} ${ms(metric.value * 1000)}`
    if (Object.hasOwn(TIMESTAMP_METRICS, metric.name)) {
      if (metric.name === 'Timestamp' || metric.name === 'NavigationStart' || navigationStart === undefined) return null
      return metric.value > 0 ? `${metric.name} ${ms((metric.value - navigationStart) * 1000)} after navigation start` : `${metric.name} not yet`
    }
    if (metric.name.endsWith('Size')) return `${metric.name} ${(metric.value / 1048576).toFixed(1)} MB`
    return `${metric.name} ${metric.value}`
  })
  deps.print(
    `METRICS ${page.url()} — Chrome's counters for this tab. The *Count and *Duration values count from when the Performance domain ` +
      `was enabled in this tab, no later than the first perf.metrics() here (${Math.round((Date.now() - since) / 1000)}s ago): ` +
      'a first call reads about 0 for them — act, then call it again to see what the action cost\n' +
      `  ${shown.filter((line) => line !== null).join(' · ')}`,
  )
  return quiet(values, '[perf.metrics() — printed above]')
}

/** The categories Chrome DevTools' Performance panel records (devtools-frontend TimelineController). */
const DEFAULT_TRACE_CATEGORIES: readonly string[] = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'v8.execute',
  'blink.console',
  'blink.user_timing',
  'loading',
  'latencyInfo',
  'toplevel',
  'disabled-by-default-v8.cpu_profiler',
]

interface TraceRun {
  cdp: ICDPSession
  startedAt: number
  categories: readonly string[]
}

/** Traces running per tab: one per tab at a time (Chrome refuses a second Tracing.start). */
const traces = new WeakMap<Page, TraceRun>()

interface TraceEvent {
  name: string
  ph: string
  ts: number
  dur: number
  pid: number
  tid: number
  args: unknown
}

/** A property of an untyped JSON value, or undefined. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function traceEvents(json: unknown): TraceEvent[] {
  const raw = Array.isArray(json) ? json : field(json, 'traceEvents')
  if (!Array.isArray(raw)) throw new Error('The trace Chrome returned has no traceEvents array.')
  const events: TraceEvent[] = []
  for (const item of raw) {
    const name = field(item, 'name')
    const ph = field(item, 'ph')
    const ts = field(item, 'ts')
    const pid = field(item, 'pid')
    const tid = field(item, 'tid')
    if (typeof name !== 'string' || typeof ph !== 'string' || typeof pid !== 'number' || typeof tid !== 'number') continue
    const dur = field(item, 'dur')
    events.push({ name, ph, ts: typeof ts === 'number' ? ts : 0, dur: typeof dur === 'number' ? dur : 0, pid, tid, args: field(item, 'args') })
  }
  return events
}

export interface TraceSummary {
  path: string | null
  bytes: number
  events: number
  durationMs: number
  /** Which thread the summary describes. */
  thread: string
  longTasks: Array<{ ms: number; atMs: number; trigger: string | null; script: string | null }>
  longTaskCount: number
  counts: Record<string, { count: number; ms: number }>
  text: string
}

/** Long tasks listed in a trace summary; the rest are counted. */
const LONG_TASKS_SHOWN = 10

/** Work counted in the trace summary: layout, style recalculation, paint, garbage collection. */
const COUNTED_EVENTS: Record<string, string> = {
  Layout: 'layout',
  UpdateLayoutTree: 'style',
  RecalculateStyles: 'style',
  Paint: 'paint',
  MajorGC: 'gc',
  MinorGC: 'gc',
}

/**
 * The trace summarised for a reader without the DevTools UI: the page's renderer main thread
 * (found through `TracingStartedInBrowser`'s frame list and the thread names), its long tasks
 * (RunTask of 50 ms or more, the longest first) with what started them and the script that ran
 * longest inside, and how much layout, style, paint and GC work it did.
 */
export function summarizeTrace(json: unknown, mainFrameId: string, filePath: string | null, bytes: number): TraceSummary {
  const events = traceEvents(json)
  const started = events.find((event) => event.name === 'TracingStartedInBrowser')
  const frames = field(field(started?.args, 'data'), 'frames')
  const frame = Array.isArray(frames) ? frames.find((entry) => field(entry, 'frame') === mainFrameId) : undefined
  const pageProcess = field(frame, 'processId')
  const mainThreads = events.filter((event) => event.ph === 'M' && event.name === 'thread_name' && field(event.args, 'name') === 'CrRendererMain')
  const ours = mainThreads.filter((event) => event.pid === pageProcess)
  const threads = ours.length > 0 ? ours : mainThreads
  const thread =
    ours.length > 0
      ? `the page's renderer main thread (process ${String(pageProcess)})`
      : `every renderer main thread (${mainThreads.length}): the trace does not say which process rendered the page`
  const onThread = (event: TraceEvent): boolean => threads.some((entry) => entry.pid === event.pid && entry.tid === event.tid)
  const main = events.filter((event) => event.ph === 'X' && onThread(event))
  const timed = events.filter((event) => event.ts > 0)
  const first = timed.length ? Math.min(...timed.map((event) => event.ts)) : 0
  const last = timed.length ? Math.max(...timed.map((event) => event.ts + event.dur)) : 0
  const tasks = main.filter((event) => event.name === 'RunTask' && event.dur >= 50_000).sort((a, b) => b.dur - a.dur)
  const longTasks = tasks.slice(0, LONG_TASKS_SHOWN).map((task) => {
    const inside = main.filter((event) => event !== task && event.pid === task.pid && event.tid === task.tid && event.ts >= task.ts && event.ts + event.dur <= task.ts + task.dur)
    const scriptEvent = inside.filter((event) => event.name === 'FunctionCall' || event.name === 'EvaluateScript' || event.name === 'v8.compile').sort((a, b) => b.dur - a.dur)[0]
    // What started the work: the innermost event dispatch, timer or frame callback around the longest
    // script (a click is dispatched inside the mouseup that caused it), else the first one in the task.
    const triggers = inside.filter((event) => ['EventDispatch', 'TimerFire', 'FireAnimationFrame', 'ParseHTML', 'FireIdleCallback'].includes(event.name))
    const around = scriptEvent ? triggers.filter((event) => event.ts <= scriptEvent.ts && event.ts + event.dur >= scriptEvent.ts + scriptEvent.dur).sort((a, b) => a.dur - b.dur) : []
    const triggerEvent = around[0] ?? triggers[0]
    const triggerType = field(field(triggerEvent?.args, 'data'), 'type')
    const trigger = triggerEvent ? `${triggerEvent.name}${typeof triggerType === 'string' ? ` ${triggerType}` : ''}` : null
    const data = field(scriptEvent?.args, 'data')
    const url = field(data, 'url')
    const line = field(data, 'lineNumber')
    const column = field(data, 'columnNumber')
    const fn = field(data, 'functionName')
    const script = scriptEvent
      ? `${scriptEvent.name}${typeof fn === 'string' && fn ? ` ${fn}` : ''}${typeof url === 'string' && url ? ` ${url}` : ''}` +
        `${typeof line === 'number' ? `:${line}${typeof column === 'number' ? `:${column}` : ''}` : ''} ${ms(scriptEvent.dur / 1000)}`
      : null
    return { ms: Math.round(task.dur / 1000), atMs: Math.round((task.ts - first) / 1000), trigger, script }
  })
  const counts: Record<string, { count: number; ms: number }> = {}
  for (const event of main) {
    const kind = Object.hasOwn(COUNTED_EVENTS, event.name) ? COUNTED_EVENTS[event.name] : undefined
    if (!kind) continue
    const entry = counts[kind] ?? { count: 0, ms: 0 }
    entry.count++
    entry.ms += event.dur / 1000
    counts[kind] = entry
  }
  const durationMs = Math.round((last - first) / 1000)
  const lines = [
    `TRACE   ${filePath ? `saved ${filePath}` : 'not saved (pass { path } to perf.trace.stop to keep the file)'} — ${(bytes / 1048576).toFixed(1)} MB, ${events.length} events over ${ms(durationMs)}; summary of ${thread}`,
    `  LONG TASKS  ${tasks.length} of 50 ms or more${tasks.length > LONG_TASKS_SHOWN ? ` (the ${LONG_TASKS_SHOWN} longest listed)` : ''}`,
    ...longTasks.map((task) => `        ${ms(task.ms)} at +${ms(task.atMs)}${task.trigger ? ` — ${task.trigger}` : ''}${task.script ? ` — longest script: ${task.script}` : ''}`),
    `  WORK  ${['layout', 'style', 'paint', 'gc'].map((kind) => `${kind} ${counts[kind]?.count ?? 0}× ${ms(counts[kind]?.ms ?? 0)}`).join(' · ')}`,
  ]
  return { path: filePath, bytes, events: events.length, durationMs, thread, longTasks, longTaskCount: tasks.length, counts, text: lines.join('\n') }
}

async function traceStart(deps: InstrumentDeps, options: unknown): Promise<{ text: string }> {
  checkKeys('perf.trace.start', options, ['categories', 'page'])
  const page = pageOption(options, deps)
  const categories: unknown = options === undefined ? undefined : Reflect.get(Object(options), 'categories')
  if (categories !== undefined && (!Array.isArray(categories) || categories.some((category) => typeof category !== 'string') || categories.length === 0)) {
    throw new ModelFacingError("perf.trace.start: `categories` must be a non-empty array of Chrome trace category names, like ['devtools.timeline', 'v8.execute']. Nothing was run.")
  }
  if (traces.has(page)) throw new ModelFacingError('perf.trace.start: a trace is already running in this tab. perf.trace.stop({ path }) ends it first.')
  const probe = await deps.probes.get(page)
  refuseWhileDialog(probe, 'perf.trace.start()')
  const included: readonly string[] = categories ?? DEFAULT_TRACE_CATEGORIES
  await withDeadline(
    probe.cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: included.filter((name) => !name.startsWith('-')), excludedCategories: included.filter((name) => name.startsWith('-')).map((name) => name.slice(1)) } }),
    CDP_TIMEOUT_MS,
    'starting a Chrome trace (Tracing.start)',
  )
  traces.set(page, { cdp: probe.cdp, startedAt: Date.now(), categories: included })
  const text = `TRACE   recording ${page.url()} (categories: ${included.join(', ')}). Act on the page, then perf.trace.stop({ path: 'trace.json' }).`
  deps.print(text)
  return quiet({ text }, '[perf.trace.start() — printed above]')
}

async function traceStop(deps: InstrumentDeps, options: unknown): Promise<TraceSummary> {
  checkKeys('perf.trace.stop', options, ['path', 'page'])
  const page = pageOption(options, deps)
  const target: unknown = options === undefined ? undefined : Reflect.get(Object(options), 'path')
  const file = target === undefined ? null : outputPath(deps.jail, target, 'perf.trace.stop', "perf.trace.stop({ path: 'trace.json' })")
  const run = traces.get(page)
  if (!run) throw new ModelFacingError('perf.trace.stop: no trace is running in this tab. Start one with perf.trace.start().')
  traces.delete(page)
  const complete = Promise.withResolvers<Protocol.Tracing.TracingCompleteEvent>()
  const onComplete = (event: Protocol.Tracing.TracingCompleteEvent): void => complete.resolve(event)
  run.cdp.on('Tracing.tracingComplete', onComplete)
  let done: Protocol.Tracing.TracingCompleteEvent
  try {
    await withDeadline(run.cdp.send('Tracing.end'), CDP_TIMEOUT_MS, 'ending the Chrome trace (Tracing.end)')
    done = await withDeadline(complete.promise, TRACE_END_TIMEOUT_MS, 'waiting for Chrome to hand over the trace (Tracing.tracingComplete)')
  } finally {
    run.cdp.off('Tracing.tracingComplete', onComplete)
  }
  if (!done.stream) throw new Error('Chrome finished the trace without a stream to read it from (Tracing.tracingComplete had no stream).')
  const data = await readStream(run.cdp, done.stream, 'the trace')
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, data)
  }
  const summary = summarizeTrace(JSON.parse(data.toString('utf8')), page.mainFrame().frameId(), file, data.length)
  if (done.dataLossOccurred) summary.text += '\n  ⚠ Chrome reports that trace data was lost (its buffer filled): the trace and this summary are incomplete'
  deps.print(summary.text)
  return quiet(summary, '[perf.trace.stop() — printed above]')
}

const profiles = new WeakMap<Page, { cdp: ICDPSession; startedAt: number }>()

export interface ProfileSummary {
  path: string | null
  durationMs: number
  samples: number
  /** Functions by self time, the most first. */
  top: Array<{ function: string; at: string; selfMs: number; percent: number }>
  text: string
}

/** Functions listed in a profile summary. */
const PROFILE_FUNCTIONS_SHOWN = 10

/** V8's pseudo-nodes: not functions of the page. */
const PSEUDO_FUNCTIONS: Record<string, true> = { '(root)': true, '(program)': true, '(idle)': true, '(garbage collector)': true }

/**
 * Self time per function of a V8 CPU profile, the way DevTools' bottom-up view computes it: each
 * sample lasts until the next one (the last until `endTime`) and is charged to the node it hit.
 */
export function summarizeProfile(profile: Protocol.Profiler.Profile, filePath: string | null): ProfileSummary {
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const selfByNode = new Map<number, number>()
  let time = profile.startTime
  const stamps = samples.map((_, index) => (time += deltas[index] ?? 0))
  samples.forEach((nodeId, index) => {
    const next = index + 1 < stamps.length ? stamps[index + 1] : profile.endTime
    selfByNode.set(nodeId, (selfByNode.get(nodeId) ?? 0) + Math.max(0, next - stamps[index]))
  })
  const byFunction = new Map<string, { function: string; at: string; self: number }>()
  const pseudo: Record<string, number> = {}
  for (const [nodeId, self] of selfByNode) {
    const frame = nodes.get(nodeId)?.callFrame
    if (!frame) continue
    if (Object.hasOwn(PSEUDO_FUNCTIONS, frame.functionName)) {
      pseudo[frame.functionName] = (pseudo[frame.functionName] ?? 0) + self
      continue
    }
    const name = frame.functionName || '(anonymous)'
    const at = frame.url ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : '(native or V8 builtin)'
    const key = `${name} ${at}`
    const entry = byFunction.get(key) ?? { function: name, at, self: 0 }
    entry.self += self
    byFunction.set(key, entry)
  }
  const total = profile.endTime - profile.startTime
  const busy = [...byFunction.values()].reduce((sum, entry) => sum + entry.self, 0) + (pseudo['(garbage collector)'] ?? 0)
  const top = [...byFunction.values()]
    .sort((a, b) => b.self - a.self)
    .slice(0, PROFILE_FUNCTIONS_SHOWN)
    .map((entry) => ({ function: entry.function, at: entry.at, selfMs: Math.round(entry.self / 100) / 10, percent: busy > 0 ? Math.round((entry.self / busy) * 1000) / 10 : 0 }))
  const lines = [
    `PROFILE ${filePath ? `saved ${filePath}` : 'not saved (pass { path } to perf.profile.stop to keep the .cpuprofile)'} — ${samples.length} samples over ${ms(total / 1000)}: ` +
      `JavaScript ${ms((busy - (pseudo['(garbage collector)'] ?? 0)) / 1000)}, GC ${ms((pseudo['(garbage collector)'] ?? 0) / 1000)}, ` +
      `other renderer work ${ms((pseudo['(program)'] ?? 0) / 1000)}, idle ${ms((pseudo['(idle)'] ?? 0) / 1000)}`,
    `  TOP SELF TIME${byFunction.size > PROFILE_FUNCTIONS_SHOWN ? ` (${PROFILE_FUNCTIONS_SHOWN} of ${byFunction.size} functions)` : ''}`,
    ...top.map((entry) => `        ${entry.selfMs} ms (${entry.percent}%) ${entry.function} — ${entry.at}`),
  ]
  return { path: filePath, durationMs: Math.round(total / 1000), samples: samples.length, top, text: lines.join('\n') }
}

async function profileStart(deps: InstrumentDeps, options: unknown): Promise<{ text: string }> {
  checkKeys('perf.profile.start', options, ['samplingIntervalUs', 'page'])
  const page = pageOption(options, deps)
  const interval: unknown = options === undefined ? undefined : Reflect.get(Object(options), 'samplingIntervalUs')
  if (interval !== undefined && (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1)) {
    throw new ModelFacingError('perf.profile.start: `samplingIntervalUs` must be a positive whole number of microseconds (V8 samples every 1000 µs by default). Nothing was run.')
  }
  if (profiles.has(page)) throw new ModelFacingError('perf.profile.start: a CPU profile is already recording in this tab. perf.profile.stop({ path }) ends it first.')
  const probe = await deps.probes.get(page)
  refuseWhileDialog(probe, 'perf.profile.start()')
  await withDeadline(probe.cdp.send('Profiler.enable'), CDP_TIMEOUT_MS, 'enabling the Profiler domain')
  if (typeof interval === 'number') await withDeadline(probe.cdp.send('Profiler.setSamplingInterval', { interval }), CDP_TIMEOUT_MS, 'setting the sampling interval')
  await withDeadline(probe.cdp.send('Profiler.start'), CDP_TIMEOUT_MS, 'starting the CPU profile (Profiler.start)')
  profiles.set(page, { cdp: probe.cdp, startedAt: Date.now() })
  const text = `PROFILE recording JavaScript CPU time in ${page.url()}. Act on the page, then perf.profile.stop({ path: 'page.cpuprofile' }).`
  deps.print(text)
  return quiet({ text }, '[perf.profile.start() — printed above]')
}

async function profileStop(deps: InstrumentDeps, options: unknown): Promise<ProfileSummary> {
  checkKeys('perf.profile.stop', options, ['path', 'page'])
  const page = pageOption(options, deps)
  const target: unknown = options === undefined ? undefined : Reflect.get(Object(options), 'path')
  const file = target === undefined ? null : outputPath(deps.jail, target, 'perf.profile.stop', "perf.profile.stop({ path: 'page.cpuprofile' })")
  const run = profiles.get(page)
  if (!run) throw new ModelFacingError('perf.profile.stop: no CPU profile is recording in this tab. Start one with perf.profile.start().')
  profiles.delete(page)
  const { profile } = await withDeadline(run.cdp.send('Profiler.stop'), TRACE_END_TIMEOUT_MS, 'stopping the CPU profile (Profiler.stop)')
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(profile))
  }
  const summary = summarizeProfile(profile, file)
  deps.print(summary.text)
  return quiet(summary, '[perf.profile.stop() — printed above]')
}

// --- PDF -------------------------------------------------------------------------------------

/** Paper sizes in inches (width × height, portrait): the ISO A series and the US sizes. */
const PAPER: Record<string, readonly [number, number]> = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  tabloid: [11, 17],
  ledger: [17, 11],
  a0: [33.1, 46.8],
  a1: [23.4, 33.1],
  a2: [16.54, 23.4],
  a3: [11.7, 16.54],
  a4: [8.27, 11.7],
  a5: [5.83, 8.27],
  a6: [4.13, 5.83],
}

export interface PdfResult {
  path: string
  bytes: number
  /** Pages counted in the file (`/Type /Page` objects); null when the file does not list them that way. */
  pages: number | null
  /** Whether the page's print handlers changed its content (its event journal, read after printing). */
  pageChanged: boolean | null
  text: string
}

async function pdf(deps: InstrumentDeps, options: unknown): Promise<PdfResult> {
  const call = 'pdf'
  const allowed = ['path', 'landscape', 'format', 'printBackground', 'pageRanges', 'page'] as const
  if (options === undefined) throw new ModelFacingError("pdf needs `path`, the file to write, like pdf({ path: 'page.pdf' }). Nothing was run.")
  checkKeys(call, options, allowed)
  const page = pageOption(options, deps)
  const get = (key: (typeof allowed)[number]): unknown => Reflect.get(Object(options), key)
  const file = outputPath(deps.jail, get('path'), call, "pdf({ path: 'page.pdf' })")
  const landscape = get('landscape')
  const format = get('format')
  const printBackground = get('printBackground')
  const pageRanges = get('pageRanges')
  if (landscape !== undefined && typeof landscape !== 'boolean') throw new ModelFacingError('pdf: `landscape` must be true or false. Nothing was run.')
  if (printBackground !== undefined && typeof printBackground !== 'boolean') throw new ModelFacingError('pdf: `printBackground` must be true or false. Nothing was run.')
  if (pageRanges !== undefined && typeof pageRanges !== 'string') throw new ModelFacingError("pdf: `pageRanges` is a string like '1-3, 5'. Nothing was run.")
  let paper: readonly [number, number] | undefined
  if (format !== undefined) {
    paper = typeof format === 'string' && Object.hasOwn(PAPER, format.toLowerCase()) ? PAPER[format.toLowerCase()] : undefined
    if (!paper) {
      throw new ModelFacingError(`pdf: \`format\` must be one of ${Object.keys(PAPER).map((name) => `'${name.length === 2 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1)}'`).join(', ')}. Nothing was run.`)
    }
  }
  const probe = await deps.probes.get(page)
  refuseWhileDialog(probe, 'pdf()')
  const checkpoint = probe.watch.checkpoint()
  let printed: Protocol.Page.PrintToPDFResponse
  try {
    printed = await withDeadline(
      probe.cdp.send('Page.printToPDF', {
        transferMode: 'ReturnAsStream',
        ...(landscape !== undefined ? { landscape } : {}),
        ...(printBackground !== undefined ? { printBackground } : {}),
        ...(pageRanges !== undefined ? { pageRanges } : {}),
        ...(paper ? { paperWidth: paper[0], paperHeight: paper[1] } : {}),
      }),
      TRACE_END_TIMEOUT_MS,
      'printing the page (Page.printToPDF)',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/page range/i.test(message)) throw new ModelFacingError(`pdf: Chrome rejected pageRanges '${String(pageRanges)}': ${message}. Nothing was saved.`)
    throw error
  }
  if (!printed.stream) throw new Error('Chrome printed the page without a stream to read the PDF from (Page.printToPDF returned no stream).')
  const data = await readStream(probe.cdp, printed.stream, 'the PDF')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  const pageCount = (data.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
  let pageChanged: boolean | null = null
  let effect: string
  try {
    const events = await probe.watch.since(checkpoint)
    pageChanged = events.mutations.content > 0 || events.navigations.length > 0
    effect = pageChanged
      ? `its print handlers changed its content (${events.mutations.content} content mutations${events.navigations.length ? `, ${events.navigations.length} navigation(s)` : ''}) — observe() shows it now`
      : 'its content did not change'
  } catch (error) {
    effect = `whether its print handlers changed it could not be read: ${error instanceof Error ? error.message : String(error)}`
  }
  const paperText = paper ? `${paper[0]}×${paper[1]} in` : "Chrome's default paper, 8.5×11 in (Letter)"
  const text =
    `PDF     saved ${file} — ${(data.length / 1024).toFixed(0)} KB${pageCount > 0 ? `, ${pageCount} page${pageCount === 1 ? '' : 's'}` : ''}, ${paperText}${landscape ? ', landscape' : ''}` +
    `${printBackground ? ', with backgrounds' : ''}${pageRanges !== undefined ? `, pages ${String(pageRanges)}` : ''}\n` +
    `        The page saw a print, as when a person presses Ctrl+P: its beforeprint/afterprint handlers and print media-query listeners ran; ${effect}.`
  deps.print(text)
  return quiet({ path: file, bytes: data.length, pages: pageCount > 0 ? pageCount : null, pageChanged, text }, '[pdf() — printed above]')
}

// --- Sandbox globals -------------------------------------------------------------------------

export interface InstrumentDeps {
  probes: PageProbes
  context: BrowserContext
  /** The controlled page (state.page). */
  currentPage: () => Page
  /** Where files may be written (the sandbox fs's folders). */
  jail: ScopedFS
  /** Prints text into the call's output. */
  print: (text: string) => void
}

export interface PerfApi {
  vitals: (options?: { page?: Page }) => Promise<VitalsResult>
  metrics: (options?: { page?: Page }) => Promise<Record<string, number>>
  trace: {
    start: (options?: { categories?: string[]; page?: Page }) => Promise<{ text: string }>
    stop: (options?: { path?: string; page?: Page }) => Promise<TraceSummary>
  }
  profile: {
    start: (options?: { samplingIntervalUs?: number; page?: Page }) => Promise<{ text: string }>
    stop: (options?: { path?: string; page?: Page }) => Promise<ProfileSummary>
  }
}

/** `perf` and `pdf` for one execute() call. Tracing and profiling state is per tab, across calls. */
export function createPerfGlobals(deps: InstrumentDeps): {
  perf: PerfApi
  pdf: (options: { path: string; landscape?: boolean; format?: string; printBackground?: boolean; pageRanges?: string; page?: Page }) => Promise<PdfResult>
} {
  return {
    perf: {
      vitals: async (options) => {
        checkKeys('perf.vitals', options, ['page'])
        const result = await vitals(deps, pageOption(options, deps))
        deps.print(result.text)
        return quiet(result, '[perf.vitals() — printed above]')
      },
      metrics: async (options) => {
        checkKeys('perf.metrics', options, ['page'])
        return await metrics(deps, pageOption(options, deps))
      },
      trace: {
        start: (options) => traceStart(deps, options),
        stop: (options) => traceStop(deps, options),
      },
      profile: {
        start: (options) => profileStart(deps, options),
        stop: (options) => profileStop(deps, options),
      },
    },
    pdf: (options) => pdf(deps, options),
  }
}
