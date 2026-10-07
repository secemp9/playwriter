/**
 * perf-observers.ts — the page's own performance timeline, watched from playwriter's isolated world.
 *
 * Chrome keeps Web Vitals entries per document: largest-contentful-paint, layout-shift, longtask,
 * long-animation-frame, event timing, paint and navigation. A `PerformanceObserver` created in the
 * CDP isolated world (isolated-world.ts) receives the same entries as one the page creates — the
 * observer list belongs to the document's Performance object, which every world shares — and with
 * `buffered: true` it also gets the entries recorded before it was created (Chrome buffers up to
 * 150 LCP, 150 layout-shift, 200 longtask, 200 long-animation-frame and 150 event entries, the
 * event ones only for events of 104 ms or more). Measured on Chrome 149 (lab vitals.html): the
 * isolated observers saw the LCP element, the banner's layout shift with its source nodes, both long
 * tasks, the long animation frame with its script (`BUTTON#heavy.onclick`, URL, function), and the
 * click's event entries with their interactionId; the page's own globals, its performance entry list
 * and its observers were unchanged. Nothing is written to the page.
 *
 * The setup below runs once per document (registered as a setup of the main frame's world, which
 * replays it whenever a navigation recreates the world). Its store lives in the isolated world only;
 * the readers return plain data and, separately, the DOM nodes behind it (LCP element, shifted
 * nodes, interaction targets), so they can be placed among observe()'s refs.
 */

/** Name of the setup in the main frame's isolated world. */
export const PERF_SETUP_NAME = 'playwriter-perf'

/** Entries kept per kind; older ones are dropped and counted (`dropped`). */
export const PERF_ENTRY_CAP = 500

/**
 * Installs the observers once per world copy. Only entry types this Chrome supports are observed
 * (observing an unsupported type would print a console warning); the others are listed in
 * `unsupported`. Event timing uses a 16 ms threshold (the smallest Chrome allows), so interactions
 * faster than 16 ms are counted (`performance.interactionCount`) but have no entry.
 */
export const PERF_OBSERVERS_SOURCE = `(() => {
  if (globalThis.__playwriterPerf) return true
  var CAP = ${PERF_ENTRY_CAP}
  var supported = typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes ? PerformanceObserver.supportedEntryTypes : []
  var store = {
    startedAt: performance.now(),
    interactionsAtStart: typeof performance.interactionCount === 'number' ? performance.interactionCount : null,
    lcp: null,
    lcpCount: 0,
    shifts: [],
    longTasks: [],
    loafs: [],
    interactions: new Map(),
    nextId: 1,
    dropped: { shifts: 0, longTasks: 0, loafs: 0, interactions: 0 },
    unsupported: [],
  }
  function keep(list, kind, entry) {
    if (list.length >= CAP) { list.shift(); store.dropped[kind]++ }
    list.push({ id: store.nextId++, entry: entry })
  }
  function observe(type, onEntry, extra) {
    if (supported.indexOf(type) < 0) { store.unsupported.push(type); return }
    var options = { type: type, buffered: true }
    if (extra) for (var key in extra) options[key] = extra[key]
    new PerformanceObserver(function (list) {
      var entries = list.getEntries()
      for (var i = 0; i < entries.length; i++) onEntry(entries[i])
    }).observe(options)
  }
  observe('largest-contentful-paint', function (entry) { store.lcp = entry; store.lcpCount++ })
  observe('layout-shift', function (entry) { keep(store.shifts, 'shifts', entry) })
  observe('longtask', function (entry) { keep(store.longTasks, 'longTasks', entry) })
  observe('long-animation-frame', function (entry) { keep(store.loafs, 'loafs', entry) })
  // One record per interaction: its longest event (the interaction's duration), the first event
  // target Chrome gives (a pointerup can come without one) and the names of its events.
  function interaction(entry) {
    if (!entry.interactionId) return
    var known = store.interactions.get(entry.interactionId)
    if (!known) {
      if (store.interactions.size >= CAP) {
        store.interactions.delete(store.interactions.keys().next().value)
        store.dropped.interactions++
      }
      known = { id: store.nextId++, entry: entry, target: null, names: [] }
      store.interactions.set(entry.interactionId, known)
    }
    if (entry.duration > known.entry.duration) known.entry = entry
    if (!known.target && entry.target) known.target = entry.target
    if (known.names.indexOf(entry.name) < 0) known.names.push(entry.name)
  }
  observe('event', interaction, { durationThreshold: 16 })
  observe('first-input', interaction)
  globalThis.__playwriterPerf = store
  return true
})()`

/** A rectangle in CSS pixels of the viewport, as layout-shift sources report it. */
export interface PerfRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PerfShift {
  id: number
  /** ms since the document's time origin. */
  startTime: number
  value: number
  hadRecentInput: boolean
  sources: Array<{ previous: PerfRect; current: PerfRect; hasNode: boolean }>
}

export interface PerfInteraction {
  id: number
  interactionId: number
  /** The interaction's event names, in the order Chrome reported them (`pointerdown/pointerup/click`). */
  name: string
  /** Timing of its longest event, which is the interaction's duration. */
  startTime: number
  duration: number
  processingStart: number
  processingEnd: number
  hasTarget: boolean
}

export interface PerfScript {
  invoker: string
  invokerType: string
  sourceURL: string
  sourceFunctionName: string
  sourceCharPosition: number
  duration: number
}

export interface PerfLoaf {
  id: number
  startTime: number
  duration: number
  blockingDuration: number
  scripts: PerfScript[]
}

export interface PerfLongTask {
  id: number
  startTime: number
  duration: number
  /** `containerType containerSrc` of each attribution (the frame the task ran for). */
  attribution: string[]
}

/** What `PERF_READ_EXPRESSION` returns: the store and the page's own navigation/paint records. */
export interface PerfRead {
  url: string
  /** The page's `Date.now()` and `performance.now()` at the read: entry times convert to wall time with them. */
  now: number
  perfNow: number
  startedAt: number
  interactionsAtStart: number | null
  interactionCount: number | null
  visibility: Array<{ name: string; startTime: number }>
  navigation: {
    type: string
    responseStart: number
    activationStart: number
    domContentLoaded: number
    load: number
  } | null
  fcp: number | null
  lcp: {
    startTime: number
    renderTime: number
    loadTime: number
    size: number
    url: string
    id: string
    hasElement: boolean
  } | null
  lcpCount: number
  shifts: PerfShift[]
  interactions: PerfInteraction[]
  longTasks: PerfLongTask[]
  loafs: PerfLoaf[]
  dropped: { shifts: number; longTasks: number; loafs: number; interactions: number }
  unsupported: string[]
}

/** Reads the store as plain data; null when the setup has not run in this world copy. */
export const PERF_READ_EXPRESSION = `(() => {
  var s = globalThis.__playwriterPerf
  if (!s) return null
  function rect(r) { return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : { x: 0, y: 0, w: 0, h: 0 } }
  var nav = performance.getEntriesByType('navigation')[0]
  var fcp = performance.getEntriesByName('first-contentful-paint', 'paint')[0]
  var lcp = s.lcp
  var interactions = []
  s.interactions.forEach(function (kept) {
    var e = kept.entry
    interactions.push({ id: kept.id, interactionId: e.interactionId, name: kept.names.join('/'), startTime: e.startTime, duration: e.duration,
      processingStart: e.processingStart, processingEnd: e.processingEnd, hasTarget: !!kept.target })
  })
  return {
    url: location.href,
    now: Date.now(),
    perfNow: performance.now(),
    startedAt: s.startedAt,
    interactionsAtStart: s.interactionsAtStart,
    interactionCount: typeof performance.interactionCount === 'number' ? performance.interactionCount : null,
    visibility: performance.getEntriesByType('visibility-state').map(function (e) { return { name: e.name, startTime: e.startTime } }),
    navigation: nav ? { type: nav.type, responseStart: nav.responseStart, activationStart: nav.activationStart || 0,
      domContentLoaded: nav.domContentLoadedEventStart, load: nav.loadEventStart } : null,
    fcp: fcp ? fcp.startTime : null,
    lcp: lcp ? { startTime: lcp.startTime, renderTime: lcp.renderTime, loadTime: lcp.loadTime, size: lcp.size, url: lcp.url || '',
      id: lcp.id || '', hasElement: !!lcp.element } : null,
    lcpCount: s.lcpCount,
    shifts: s.shifts.map(function (kept) {
      var e = kept.entry
      return { id: kept.id, startTime: e.startTime, value: e.value, hadRecentInput: e.hadRecentInput,
        sources: (e.sources || []).map(function (src) { return { previous: rect(src.previousRect), current: rect(src.currentRect), hasNode: !!src.node } }) }
    }),
    interactions: interactions,
    longTasks: s.longTasks.map(function (kept) {
      var e = kept.entry
      return { id: kept.id, startTime: e.startTime, duration: e.duration,
        attribution: (e.attribution || []).map(function (a) { return (a.containerType || '') + (a.containerSrc ? ' ' + a.containerSrc : '') }) }
    }),
    loafs: s.loafs.map(function (kept) {
      var e = kept.entry
      return { id: kept.id, startTime: e.startTime, duration: e.duration, blockingDuration: e.blockingDuration || 0,
        scripts: (e.scripts || []).map(function (x) { return { invoker: x.invoker || '', invokerType: x.invokerType || '', sourceURL: x.sourceURL || '',
          sourceFunctionName: x.sourceFunctionName || '', sourceCharPosition: typeof x.sourceCharPosition === 'number' ? x.sourceCharPosition : -1, duration: x.duration } }) }
    }),
    dropped: { shifts: s.dropped.shifts, longTasks: s.dropped.longTasks, loafs: s.dropped.loafs, interactions: s.dropped.interactions },
    unsupported: s.unsupported.slice(),
  }
})()`

/** What `PERF_NODES_FN` is asked for: the LCP element, the source nodes of these shifts (`sources`: how many it had at the read), the target of these interactions. */
export interface PerfNodeRequest {
  lcp: boolean
  shifts: Array<{ id: number; sources: number }>
  interactions: number[]
}

/**
 * `IsolatedWorld.nodesReturnedBy` function: the nodes behind a `PerfNodeRequest`, in its order —
 * one slot for the LCP element (when asked), one per source of each shift, one per interaction —
 * null where the node is gone or the entry was dropped since the read.
 */
export const PERF_NODES_FN = `function (args) {
  var s = globalThis.__playwriterPerf
  var out = []
  if (!s) return out
  if (args.lcp) out.push(s.lcp && s.lcp.element ? s.lcp.element : null)
  for (var i = 0; i < args.shifts.length; i++) {
    var kept = null
    for (var j = 0; j < s.shifts.length; j++) if (s.shifts[j].id === args.shifts[i].id) kept = s.shifts[j]
    var count = args.shifts[i].sources
    for (var k = 0; k < count; k++) {
      var src = kept && kept.entry.sources ? kept.entry.sources[k] : null
      out.push(src && src.node ? src.node : null)
    }
  }
  for (var m = 0; m < args.interactions.length; m++) {
    var found = null
    s.interactions.forEach(function (kept) { if (kept.id === args.interactions[m]) found = kept.target })
    out.push(found)
  }
  return out
}`
