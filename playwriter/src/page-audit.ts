/**
 * page-audit.ts — `audit()`: an accessibility audit of the page with axe-core, run where the page
 * cannot see it, plus the checks axe does not make that a page shows a person who cannot see it.
 *
 * Where it runs. axe-core is loaded into the CDP ISOLATED world of each frame (the same private
 * world every probe of the frame uses, `PageFrames`): it shares the frame's DOM and layout but
 * none of its globals, so the page never sees `window.axe`, and nothing is written to the DOM.
 * Measured in axe-core 4.14.0, and handled here:
 *   - at load axe adds a `message` listener to the window for its cross-frame messaging; it is
 *     removed in the same task (`axe.frameMessenger` with a no-op messenger) and never used — every
 *     frame is audited through its own session instead of by postMessage;
 *   - axe's `cssom` preload re-fetches cross-origin stylesheets with XHR (a request the page's
 *     server sees), so preload is limited to `media` (it only waits for `loadedmetadata` of
 *     autoplaying media). The one rule that needs the CSSOM, `css-orientation-lock`, is refused;
 *   - axe does not scroll, focus, add styles or fire events in Chromium (`injectStyle` and
 *     `setScrollState` exist but nothing calls them; the `elementsFromPoint` polyfill and the
 *     core-js iframe fallback run only where Chromium has native APIs).
 * What the page CAN see: the main thread is busy while axe runs (a `longtask` PerformanceObserver
 * entry for each slice of work over 50 ms). No read of a renderer avoids that.
 *
 * Frames. axe judges some rules over the whole page, across frames (heading order, landmarks, one
 * h1, duplicate ids, region): those run with axe's own multi-frame API, `axe.runPartial` in every
 * frame and `axe.finishRun` over all of them, exactly as axe merges frames itself. That API also
 * serialises every node it checks with its xpath and ancestry — measured on a 12 000-element page:
 * 29 s instead of 5 s — so every other rule (judged node by node) runs with `axe.run` in each
 * frame on its own, with the frame context axe would give it. The frame tree is axe's
 * (`axe.utils.getFrameContexts`), each iframe matched to its frame by the `<iframe>` element
 * (`DOM.getFrameOwner`), same-process and out-of-process frames alike.
 *
 * Elements to refs. Each node axe reports is found again from axe's own (unique) selector in the
 * frame's world and compared with the elements the latest observation lists in that frame: the
 * element itself gives its ref, a listed ancestor gives "inside [ref]", anything else is shown by
 * its markup.
 *
 * Checks axe does not make (measured on the lab's a11y page: axe passes a field named only by its
 * placeholder, and a `<div>` with a click listener):
 *   - `placeholder-only-label`: a text field whose only name is its placeholder (an axe rule
 *     registered in each world; HTML-AAM name order: aria-labelledby, aria-label, label, title);
 *   - `clickable-without-keyboard`: an element Chromium reports clickable (DOMSnapshot
 *     `isClickable`: a click listener on the element itself) that observe lists as `clickable`
 *     because it has no control role — not focusable, or focusable but announced as text.
 *   - `duplicate-id`: axe's own rule, off by default since WCAG 2.2 made 4.1.1 obsolete, is on:
 *     a duplicate id still breaks `<label for>` and `aria-labelledby`.
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { Page } from '@xmorse/playwright-core'
import { FrameGoneError } from './cdp-session.js'
import { PageUnresponsiveError } from './isolated-world.js'
import type { FrameEntry, UnreadableFrame } from './page-frames.js'
import { quote, shortElement, type Observation, type ObservedElement } from './page-observe.js'
import type { PageProbes } from './page-probe.js'
import { ModelFacingError } from './probe-types.js'

const require = createRequire(import.meta.url)

/** Time kept back from the call's deadline for the observation and the ref mapping after axe. */
const RESERVE_MS = 3000
/** Elements printed per rule; the value audit() returns has all of them. */
const MAX_NODES_SHOWN = 10
/** Characters of an element's markup printed for one that has no ref. */
const MAX_MARKUP_SHOWN = 160

export type AuditImpact = 'critical' | 'serious' | 'moderate' | 'minor'
const IMPACT_ORDER: AuditImpact[] = ['critical', 'serious', 'moderate', 'minor']

/** axe's selector for an element: one entry per frame from the top of the audit, a string[] where it crosses shadow roots. */
export type AuditSelector = Array<string | string[]>

export interface AuditNode {
  /** The element's ref, when observe lists the element itself. */
  ref?: number
  /** The listed element it is inside, when it is not listed itself. */
  insideRef?: number
  /** The element is no longer on the page (removed, or its frame navigated) after axe checked it. */
  gone?: true
  /** How the report names it: `[4] button (unnamed)`, or its markup. */
  label: string
  /** The frame's address. */
  frameUrl: string
  /** axe's selector for it. */
  selector: AuditSelector
  /** Its markup as axe recorded it (axe shortens long markup). */
  html: string
  impact: AuditImpact | null
  /** What is wrong, one line per failed check (for a rule that passes when any check passes, every way it failed). */
  messages: string[]
  /** Other elements the checks name (the other element with the same id, the background element…). */
  related: Array<{ selector: AuditSelector; html: string }>
}

export interface AuditRule {
  id: string
  impact: AuditImpact | null
  help: string
  description: string
  helpUrl: string
  tags: string[]
  /** `axe`: an axe-core rule; `playwriter`: one of the checks added here. */
  source: 'axe' | 'playwriter'
  nodes: AuditNode[]
}

export interface AuditReport {
  url: string
  axeVersion: string
  /** `page`, or the ref the audit was limited to. */
  scope: 'page' | number
  /** Every frame audited: its address, how many elements it has (open shadow roots included) and how long axe took on it. */
  frames: Array<{ url: string; elements: number; ms: number }>
  /** Frames in scope that were not audited, and why. */
  notAudited: Array<{ url: string; reason: string }>
  elements: number
  ms: number
  violations: AuditRule[]
  /** What axe could not decide (a background image behind text…): to check by hand. */
  incomplete: AuditRule[]
  /** Rules that ran and found nothing wrong. */
  passed: string[]
  /** Rules that ran and found nothing to check. */
  inapplicable: string[]
  /** Rules that did not run, and why. */
  notRun: Array<{ id: string; why: string }>
  /** The report audit() printed. */
  text: string
}

export interface AuditDeps {
  probes: PageProbes
  /** The sandbox's current page (`page`, which user code may reassign). */
  currentPage: () => Page
  /** An observation the model is not shown: refs for the elements, nothing else. */
  observeQuietly: (page: Page) => Promise<Observation>
  /** When the execute call must have answered. */
  deadlineAt: number
}

// ---------------------------------------------------------------- rule metadata (Node side)

interface RuleMeta {
  id: string
  description: string
  help: string
  helpUrl: string
  tags: string[]
  enabledByDefault: boolean
  /** Judged over the whole page only (axe skips it for an element). */
  pageLevel: boolean
  /** Judged across nodes and frames by an `after` step: runs through runPartial/finishRun. */
  crossFrame: boolean
  source: 'axe' | 'playwriter'
}

/** Rules that need axe's `cssom` preload, which re-fetches cross-origin stylesheets (axe-core 4.14.0: the only one). */
const CSSOM_RULES: Record<string, true> = { 'css-orientation-lock': true }

const PLACEHOLDER_RULE: RuleMeta = {
  id: 'placeholder-only-label',
  description: 'Ensure a text field has a name besides its placeholder',
  help: 'Form fields must not be labelled by their placeholder alone',
  helpUrl: 'https://www.w3.org/WAI/tutorials/forms/instructions/#placeholder-text',
  tags: ['playwriter', 'cat.forms', 'wcag2a', 'wcag332'],
  enabledByDefault: true,
  pageLevel: false,
  crossFrame: false,
  source: 'playwriter',
}

const CLICKABLE_RULE: RuleMeta = {
  id: 'clickable-without-keyboard',
  description: 'Ensure elements that respond to clicks are controls a keyboard reaches and assistive technology announces',
  help: 'Clickable elements must be keyboard-reachable controls',
  helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html',
  tags: ['playwriter', 'cat.keyboard', 'wcag2a', 'wcag211', 'wcag412'],
  enabledByDefault: true,
  pageLevel: false,
  crossFrame: false,
  source: 'playwriter',
}

/** axe rules that are off by default but are turned on here, and why. */
const TURNED_ON: Record<string, true> = { 'duplicate-id': true }

interface AxeRuleInternals {
  id: string
  pageLevel?: boolean
  any: Array<string | { id: string }>
  all: Array<string | { id: string }>
  none: Array<string | { id: string }>
}

interface AxeNodeModule {
  version: string
  getRules: () => Array<{ ruleId: string; description: string; help: string; helpUrl: string; tags: string[]; enabled?: boolean }>
  _audit: { rules: AxeRuleInternals[]; checks: Record<string, { after?: unknown }>; tagExclude: string[] }
}

function isAxeNodeModule(value: unknown): value is AxeNodeModule {
  if (typeof value !== 'object' || value === null) return false
  if (!('version' in value) || typeof value.version !== 'string' || !('getRules' in value) || typeof value.getRules !== 'function') return false
  if (!('_audit' in value) || typeof value._audit !== 'object' || value._audit === null) return false
  const internals = value._audit
  return 'rules' in internals && Array.isArray(internals.rules) && 'checks' in internals && 'tagExclude' in internals && Array.isArray(internals.tagExclude)
}

interface AxeCatalog {
  version: string
  rules: Map<string, RuleMeta>
  tagExclude: string[]
  tags: string[]
}

let catalog: AxeCatalog | null = null

/** The rules of the installed axe-core, read from axe itself (loaded once in Node), and the checks added here. */
export function auditCatalog(): AxeCatalog {
  if (catalog) return catalog
  const loaded: unknown = require('axe-core')
  if (!isAxeNodeModule(loaded)) {
    throw new Error('page-audit.ts reads axe-core 4.14.0 rule internals (_audit.rules, _audit.checks, tagExclude); the installed axe-core does not have them.')
  }
  const internals = new Map(loaded._audit.rules.map((rule) => [rule.id, rule]))
  const checkId = (check: string | { id: string }): string => (typeof check === 'string' ? check : check.id)
  const rules = new Map<string, RuleMeta>()
  for (const rule of loaded.getRules()) {
    const inner = internals.get(rule.ruleId)
    if (!inner) throw new Error(`axe-core lists rule ${rule.ruleId} but has no internals for it.`)
    const checks = [...inner.any, ...inner.all, ...inner.none].map(checkId)
    rules.set(rule.ruleId, {
      id: rule.ruleId,
      description: rule.description,
      help: rule.help,
      helpUrl: cleanHelpUrl(rule.helpUrl),
      tags: rule.tags,
      enabledByDefault: rule.enabled !== false,
      pageLevel: inner.pageLevel === true,
      crossFrame: checks.some((id) => typeof loaded._audit.checks[id]?.after === 'function'),
      source: 'axe',
    })
  }
  rules.set(PLACEHOLDER_RULE.id, PLACEHOLDER_RULE)
  rules.set(CLICKABLE_RULE.id, CLICKABLE_RULE)
  const tags = [...new Set([...rules.values()].flatMap((rule) => rule.tags))].sort()
  catalog = { version: loaded.version, rules, tagExclude: [...loaded._audit.tagExclude], tags }
  return catalog
}

/** axe's help links carry `?application=axeAPI`, a tracking parameter of no use to the reader. */
function cleanHelpUrl(href: string): string {
  const url = new URL(href)
  url.searchParams.delete('application')
  return url.toString()
}

let axeSource: string | null = null
function axeSourceText(): string {
  axeSource ??= fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf-8')
  return axeSource
}

// ---------------------------------------------------------------- options

interface AuditOptions {
  ref?: number | string
  rules?: string[]
  tags?: string[]
  page?: Page
}

const OPTION_KEYS = ['ref', 'rules', 'tags', 'page']

function isPage(value: unknown): value is Page {
  return typeof value === 'object' && value !== null && 'mainFrame' in value && typeof value.mainFrame === 'function'
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    throw new ModelFacingError(`audit: \`${name}\` is a non-empty array of strings, e.g. audit({ ${name}: ${name === 'rules' ? "['color-contrast']" : "['wcag2a', 'wcag2aa']"} }).`)
  }
  return value
}

function parseOptions(options: unknown): AuditOptions {
  if (options === undefined) return {}
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new ModelFacingError('audit takes one optional object: audit(), audit({ ref: 12 }), audit({ rules: [...] }) or audit({ tags: [...] }).')
  }
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new ModelFacingError(`audit: unknown option ${unknown.map((key) => `\`${key}\``).join(', ')}. Options: ref, rules, tags, page.`)
  }
  const parsed: AuditOptions = {}
  if ('ref' in options && options.ref !== undefined) {
    if (typeof options.ref !== 'number' && typeof options.ref !== 'string') throw new ModelFacingError('audit: `ref` is a ref from observe() or find(), e.g. audit({ ref: 12 }).')
    parsed.ref = options.ref
  }
  if ('rules' in options && options.rules !== undefined) parsed.rules = stringList(options.rules, 'rules')
  if ('tags' in options && options.tags !== undefined) parsed.tags = stringList(options.tags, 'tags')
  if (parsed.rules && parsed.tags) {
    throw new ModelFacingError('audit: pass `rules` or `tags`, not both — `rules` runs exactly the rules named, `tags` every rule with one of the tags.')
  }
  if ('page' in options && options.page !== undefined) {
    if (!isPage(options.page)) throw new ModelFacingError('audit: `page` is a Page, e.g. audit({ page: state.page }).')
    parsed.page = options.page
  }
  return parsed
}

/**
 * axe's own `matchTags` (axe-core 4.14.0), with its default exclusion of experimental and deprecated
 * rules; with no tags, the rules `TURNED_ON` here run too.
 */
function matchesTags(rule: RuleMeta, tags: string[], tagExclude: string[]): boolean {
  if (tags.length === 0 && TURNED_ON[rule.id] === true) return true
  const exclude = tagExclude.filter((tag) => !tags.includes(tag))
  const matching = tags.length === 0 ? rule.enabledByDefault : tags.some((tag) => rule.tags.includes(tag))
  return matching && exclude.every((tag) => !rule.tags.includes(tag))
}

interface Selection {
  run: RuleMeta[]
  notRun: Array<{ id: string; why: string }>
}

function selectRules(options: AuditOptions, scopedToElement: boolean): Selection {
  const { rules, tagExclude, tags: knownTags } = auditCatalog()
  const notRun: Array<{ id: string; why: string }> = []
  let chosen: RuleMeta[]
  if (options.rules) {
    const unknown = options.rules.filter((id) => !rules.has(id))
    if (unknown.length > 0) {
      throw new ModelFacingError(`audit: no rule ${unknown.map((id) => `"${id}"`).join(', ')}. The rules: ${[...rules.keys()].sort().join(', ')}.`)
    }
    const cssom = options.rules.filter((id) => CSSOM_RULES[id] === true)
    if (cssom.length > 0) {
      throw new ModelFacingError(
        `audit: ${cssom.join(', ')} needs axe to download the page's cross-origin stylesheets again — requests the page's server sees — so audit() does not run it. Nothing was run.`,
      )
    }
    chosen = options.rules.map((id) => rules.get(id)).filter((rule): rule is RuleMeta => rule !== undefined)
  } else {
    const tags = options.tags ?? []
    const unknown = tags.filter((tag) => !knownTags.includes(tag))
    if (unknown.length > 0) {
      throw new ModelFacingError(`audit: no rule has the tag ${unknown.map((tag) => `"${tag}"`).join(', ')}. The tags: ${knownTags.join(', ')}.`)
    }
    chosen = []
    for (const rule of rules.values()) {
      if (!matchesTags(rule, tags, tagExclude)) {
        if (!options.tags) {
          const excluded = rule.tags.filter((tag) => tagExclude.includes(tag))
          notRun.push({ id: rule.id, why: excluded.length > 0 ? `axe leaves ${excluded.join('/')} rules out by default` : 'off by default in axe' })
        }
        continue
      }
      if (CSSOM_RULES[rule.id] === true) {
        notRun.push({ id: rule.id, why: "needs axe to download the page's cross-origin stylesheets again (requests the server sees)" })
        continue
      }
      chosen.push(rule)
    }
    if (options.tags) {
      const others = rules.size - chosen.length - notRun.length
      if (others > 0) notRun.push({ id: `${others} other rules`, why: `none of the tags ${tags.join(', ')}` })
    }
  }
  if (options.rules) {
    const others = rules.size - chosen.length
    if (others > 0) notRun.push({ id: `${others} other rules`, why: 'not in `rules`' })
  }
  const run: RuleMeta[] = []
  for (const rule of chosen) {
    if (scopedToElement && rule.pageLevel) notRun.push({ id: rule.id, why: 'judged over the whole page; not for one element' })
    else run.push(rule)
  }
  return { run, notRun }
}

// ---------------------------------------------------------------- in-world scripts

/**
 * Set up a freshly loaded axe in the world: no frame messaging (it would answer the page's
 * postMessage traffic and is never needed: each frame is audited through its own session) and the
 * placeholder check, registered as an axe rule so selection, hidden-element handling and frames
 * work as for axe's own.
 */
const INSTALL_SOURCE = `(function install(axe) {
  axe.frameMessenger({ open() { return undefined }, post() { return false } })
  // runPartial serialises every node it checks with an xpath nobody here reads (finishRun only
  // concatenates it): measured, the xpaths were half of runPartial's time on a 12 000-element page.
  const dq = axe.utils.DqElement && axe.utils.DqElement.prototype
  const xpath = dq && Object.getOwnPropertyDescriptor(dq, 'xpath')
  if (!xpath || typeof xpath.get !== 'function') throw new Error('axe-core ' + axe.version + ' has no DqElement.prototype.xpath getter; page-audit.ts must be updated for it')
  Object.defineProperty(dq, 'xpath', { configurable: true, enumerable: xpath.enumerable, get() { return this.spec.xpath || [] } })
  const text = (value) => (value || '').replace(/\\s+/g, ' ').trim()
  axe.configure({
    checks: [{
      id: 'playwriter-placeholder-only',
      evaluate: function (node) {
        const placeholder = text(node.getAttribute('placeholder')) || text(node.getAttribute('aria-placeholder'))
        if (!placeholder) return false
        if (text(node.getAttribute('aria-label'))) return false
        const labelledby = text(node.getAttribute('aria-labelledby'))
        if (labelledby) {
          const root = node.getRootNode()
          const named = labelledby.split(' ').some((id) => {
            const target = typeof root.getElementById === 'function' ? root.getElementById(id) : document.getElementById(id)
            return target && text(target.textContent)
          })
          if (named) return false
        }
        if (node.labels && Array.from(node.labels).some((label) => text(label.textContent))) return false
        if (text(node.getAttribute('title'))) return false
        return true
      },
      metadata: {
        impact: 'serious',
        messages: {
          pass: 'It has a name besides its placeholder',
          fail: 'Its only name is its placeholder, which disappears as soon as the user types and is not announced as a label by every screen reader: add a <label> (or aria-label)',
        },
      },
    }],
    rules: [{
      id: ${JSON.stringify(PLACEHOLDER_RULE.id)},
      selector: 'input[placeholder]:not([type="hidden"]), textarea[placeholder], [aria-placeholder]',
      excludeHidden: true,
      tags: ${JSON.stringify(PLACEHOLDER_RULE.tags)},
      metadata: { description: ${JSON.stringify(PLACEHOLDER_RULE.description)}, help: ${JSON.stringify(PLACEHOLDER_RULE.help)}, helpUrl: ${JSON.stringify(PLACEHOLDER_RULE.helpUrl)} },
      any: [],
      all: [],
      none: ['playwriter-placeholder-only'],
    }],
  })
  return axe.version
})(axe)`

/**
 * axe's report entries reduced to what audit() keeps (the DOM-free part). With `elements` (an
 * axe.run with `elementRef`), each node's element is kept in that array and the node carries its
 * index, so it is placed among the refs without being searched for again.
 */
const SLIM_FN = `(results, elements) => results.map((rule) => ({
  id: rule.id,
  impact: rule.impact || null,
  nodes: rule.nodes.map((node) => {
    const failed = [...(node.any || []), ...(node.all || []), ...(node.none || [])]
    const related = []
    for (const check of failed) for (const other of check.relatedNodes || []) if (!related.some((seen) => JSON.stringify(seen.selector) === JSON.stringify(other.target))) related.push({ selector: other.target, html: other.html })
    const slim = { target: node.target, html: node.html, impact: node.impact || null, messages: failed.map((check) => check.message).filter(Boolean), related }
    if (elements) slim.index = elements.push(node.element || null) - 1
    return slim
  }),
}))`

/** The axe status of the world: '' when axe is not loaded in it (a new world after a navigation). */
const AXE_VERSION_EXPRESSION = `typeof axe === 'object' && axe !== null && typeof axe.runPartial === 'function' ? axe.version : ''`

/**
 * Audit one frame: the cross-frame rules with runPartial (kept in the world for the root, returned
 * for a child), every other rule with axe.run, the frames axe sees inside, and the size of what was
 * checked. A run an earlier call gave up on (out of time) is waited for first: axe runs one audit at
 * a time per world.
 */
const RUN_FN = `async function (args, scope) {
  if (typeof axe !== 'object' || axe === null) return { missing: true }
  const slim = ${SLIM_FN}
  const state = globalThis.__playwriterAudit || (globalThis.__playwriterAudit = { running: null, partial: null, frames: null })
  if (state.running) await state.running.catch(() => {})
  const work = (async () => {
    const started = performance.now()
    const context = args.context || scope || document
    const preload = { assets: ['media'], timeout: args.preloadTimeoutMs }
    let partial = null
    if (args.crossRules.length > 0) partial = await axe.runPartial(context, { runOnly: { type: 'rule', values: args.crossRules }, preload })
    const frameContexts = axe.utils.getFrameContexts(context, {})
    let local = null
    if (args.localRules.length > 0) {
      const ownContext = args.context ? Object.assign({}, args.context, { initiator: true }) : context
      local = await axe.run(ownContext, { iframes: false, elementRef: true, runOnly: { type: 'rule', values: args.localRules }, resultTypes: ['violations', 'incomplete'], preload })
    }
    state.frames = frameContexts.map((entry) => { try { return axe.utils.shadowSelect(entry.frameSelector) } catch (error) { return null } })
    state.partial = args.keepPartial ? partial : null
    state.elements = []
    let elements = 0
    const roots = [scope || document.documentElement]
    while (roots.length > 0) {
      const root = roots.pop()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
      for (let node = root.nodeType === 1 ? root : walker.nextNode(); node; node = walker.nextNode()) {
        elements++
        if (node.shadowRoot) roots.push(node.shadowRoot)
      }
    }
    return {
      elements,
      ms: Math.round(performance.now() - started),
      frameContexts: frameContexts.map((entry) => entry.frameContext),
      frameSpecs: frameContexts.map((entry, index) => (partial && partial.frames[index] ? partial.frames[index].selector : null)),
      partial: args.keepPartial ? null : partial,
      local: local ? { violations: slim(local.violations, state.elements), incomplete: slim(local.incomplete, state.elements), passes: local.passes.map((rule) => rule.id), inapplicable: local.inapplicable.map((rule) => rule.id) } : null,
    }
  })()
  state.running = work
  try {
    return await work
  } finally {
    if (state.running === work) state.running = null
  }
}`

/** The `<iframe>` elements of the last run's frame contexts, in order (null where one was not found). */
const TAKE_FRAMES_FN = `function () {
  const state = globalThis.__playwriterAudit
  const frames = state && state.frames ? state.frames : []
  if (state) state.frames = null
  return frames
}`

/** axe.finishRun over the root's partial result (kept in its world) and its frames', depth first. */
const FINISH_FN = `async function (args) {
  if (typeof axe !== 'object' || axe === null) return { missing: true }
  const slim = ${SLIM_FN}
  const state = globalThis.__playwriterAudit
  const root = state ? state.partial : null
  if (state) state.partial = null
  if (!root) return { missing: true }
  const results = await axe.finishRun([root, ...args.children], { resultTypes: ['violations', 'incomplete'] })
  return { violations: slim(results.violations), incomplete: slim(results.incomplete), passes: results.passes.map((rule) => rule.id), inapplicable: results.inapplicable.map((rule) => rule.id) }
}`

/**
 * The elements axe reported in this frame — kept by the last run (`indexes`) or found from axe's
 * selector (`selectors`, the cross-frame rules' nodes) — compared with the listed elements passed
 * in: itself, a listed ancestor, or neither. The kept elements are released.
 */
const PLACE_FN = `function (args, ...listed) {
  const index = new Map()
  listed.forEach((element, position) => { if (element) index.set(element, position) })
  const place = (element) => {
    if (!element || !element.isConnected) return { gone: true }
    if (index.has(element)) return { exact: index.get(element) }
    for (let node = element.parentNode || element.host; node; node = node.parentNode || node.host) {
      if (index.has(node)) return { inside: index.get(node) }
    }
    return {}
  }
  const state = globalThis.__playwriterAudit
  const kept = state && state.elements ? state.elements : []
  if (state) state.elements = null
  return {
    byIndex: args.indexes.map((position) => place(kept[position] || null)),
    bySelector: args.selectors.map((selector) => {
      try { return place(axe.utils.shadowSelect(selector)) } catch (error) { return { gone: true } }
    }),
  }
}`

/** Which of the elements are inside `scope` (shadow roots crossed). */
const CONTAINS_FN = `function (_args, scope, ...elements) {
  return elements.map((element) => {
    for (let node = element; node; node = node.parentNode || node.host) if (node === scope) return true
    return false
  })
}`

// ---------------------------------------------------------------- world results

interface SlimNode {
  target: AuditSelector
  html: string
  impact: AuditImpact | null
  messages: string[]
  related: Array<{ selector: AuditSelector; html: string }>
  /** Where the frame's world keeps the element (nodes of axe.run only). */
  index?: number
}

interface SlimRule {
  id: string
  impact: AuditImpact | null
  nodes: SlimNode[]
}

interface SlimResults {
  violations: SlimRule[]
  incomplete: SlimRule[]
  passes: string[]
  inapplicable: string[]
}

/** axe's description of an iframe for the frame's own audit (include/exclude, focusable, size, page). */
type FrameContext = Record<string, unknown>

interface FrameRun {
  missing?: true
  elements: number
  ms: number
  frameContexts: FrameContext[]
  frameSpecs: Array<AuditSelector | null>
  partial: unknown
  local: SlimResults | null
}

interface Placement {
  gone?: true
  exact?: number
  inside?: number
}

interface AuditedFrame {
  entry: FrameEntry
  /** axe's selectors of the iframes from the root down to this frame (finishRun's frame spec). */
  prefix: AuditSelector
  elements: number
  ms: number
  local: SlimResults | null
}

// ---------------------------------------------------------------- the audit

/** Run the audit and render it. The caller prints `text`. */
export async function runAudit(rawOptions: unknown, deps: AuditDeps): Promise<AuditReport> {
  const options = parseOptions(rawOptions)
  const startedAt = Date.now()
  const element = options.ref === undefined ? null : await deps.probes.element(options.ref)
  if (element && options.page && element.page !== options.page) {
    throw new ModelFacingError(`audit: [${element.target.ref}] is in another tab than the \`page\` you passed. Pass the ref alone: refs name their tab.`)
  }
  const page = element ? element.page : (options.page ?? deps.currentPage())
  const probe = element ? element.probe : await deps.probes.get(page)
  const dialog = probe.dialogs.current()
  if (dialog) {
    throw new ModelFacingError(
      `A native ${dialog.type}("${dialog.message}") dialog is open and freezes the page, so it cannot be audited. ` +
        'Handle it first, like a person would: act.dialog.accept() or act.dialog.dismiss().',
    )
  }
  const selection = selectRules(options, element !== null)
  const { version } = auditCatalog()
  const axeRules = selection.run.filter((rule) => rule.id !== CLICKABLE_RULE.id)
  const runsClickable = selection.run.some((rule) => rule.id === CLICKABLE_RULE.id)

  const { frames, unreadable } = await probe.frames.list()
  const rootEntry = frames.find((entry) => entry.frameId === (element ? element.target.frameId : probe.frames.mainFrameId()))
  if (!rootEntry) {
    const why = unreadable.find((entry) => entry.frameId === (element ? element.target.frameId : probe.frames.mainFrameId()))
    throw new ModelFacingError(`audit: the ${element ? `frame of [${element.target.ref}]` : 'page'} cannot be read${why ? `: ${why.reason}` : ''}.`)
  }
  // With no frame below the audited one there is nothing to merge: finishRun over one partial result
  // is axe.run, which is several times faster (runPartial serialises every node it checks).
  const hasFrames = [...frames, ...unreadable].some((entry) => entry.frameId !== rootEntry.frameId && isUnder(entry, rootEntry.frameId, frames, unreadable))
  const crossRules = hasFrames ? axeRules.filter((rule) => rule.crossFrame).map((rule) => rule.id) : []
  const localRules = axeRules.filter((rule) => !hasFrames || !rule.crossFrame).map((rule) => rule.id)

  const audited: AuditedFrame[] = []
  const notAudited: Array<{ url: string; reason: string }> = []
  const childPartials: unknown[] = []
  const timeLeft = (): number => deps.deadlineAt - Date.now() - RESERVE_MS

  const runIn = async (entry: FrameEntry, args: Record<string, unknown>, scopeIds: number[]): Promise<FrameRun> => {
    for (let attempt = 0; ; attempt++) {
      await ensureAxe(entry, timeLeft())
      const run = await entry.world.callFunctionOnNodes<FrameRun>(scopeIds, RUN_FN, {
        args: { ...args, preloadTimeoutMs: Math.max(1000, Math.min(10_000, timeLeft())) },
        timeoutMs: positive(timeLeft(), entry),
        what: `running axe-core in ${describeFrame(entry)}`,
      })
      if (!run.missing) return run
      if (attempt > 0) throw new ModelFacingError(`audit: ${describeFrame(entry)} navigated twice while it was being audited. Call audit() again once it has loaded.`)
    }
  }

  const visit = async (entry: FrameEntry, frameContext: FrameContext | null, prefix: AuditSelector): Promise<void> => {
    const isRoot = entry === rootEntry
    const run = await runIn(
      entry,
      { context: frameContext, keepPartial: isRoot, crossRules, localRules },
      isRoot && element ? [element.target.backendNodeId] : [],
    )
    audited.push({ entry, prefix, elements: run.elements, ms: run.ms, local: run.local })
    if (!isRoot) childPartials.push(run.partial)
    const iframeIds = await entry.world.nodesReturnedBy([], TAKE_FRAMES_FN, {
      timeoutMs: positive(timeLeft(), entry),
      what: `finding the iframes axe audits in ${describeFrame(entry)}`,
    })
    const children = frames.filter((candidate) => candidate.parentId === entry.frameId)
    const owners = await Promise.all(
      children.map(async (child) => {
        try {
          return { child, backendNodeId: (await probe.frames.owner(child.frameId)).backendNodeId }
        } catch (error) {
          if (error instanceof FrameGoneError) return { child, backendNodeId: null }
          throw error
        }
      }),
    )
    const matched = new Set<FrameEntry>()
    for (const [index, iframeId] of iframeIds.entries()) {
      const owner = iframeId === null ? undefined : owners.find((candidate) => candidate.backendNodeId === iframeId)
      if (!owner) {
        // An iframe axe audits whose document cannot be read: finishRun counts it as untested.
        childPartials.push(null)
        continue
      }
      matched.add(owner.child)
      await visit(owner.child, run.frameContexts[index] ?? null, [...prefix, ...(run.frameSpecs[index] ?? [])])
    }
    for (const child of children) {
      if (matched.has(child)) continue
      notAudited.push({
        url: child.url,
        reason: element && isRoot
          ? `axe does not audit it: its <iframe> is outside [${element.target.ref}] or hidden from screen readers (display:none, visibility:hidden or aria-hidden)`
          : 'axe does not audit it: its <iframe> is hidden from screen readers (display:none, visibility:hidden or aria-hidden)',
      })
    }
  }

  try {
    await visit(rootEntry, null, [])
  } catch (error) {
    if (error instanceof PageUnresponsiveError) throw outOfTime(error, audited, startedAt)
    throw error
  }
  const inScope = new Set(audited.map((frame) => frame.entry.frameId))
  for (const entry of unreadable) {
    if (isUnder(entry, rootEntry.frameId, frames, unreadable)) notAudited.push({ url: entry.url || '(no address)', reason: entry.reason })
  }

  let crossResults: SlimResults | null = null
  if (crossRules.length > 0) {
    await ensureAxe(rootEntry, timeLeft())
    const finished = await rootEntry.world.callFunctionOnNodes<SlimResults & { missing?: true }>([], FINISH_FN, {
      args: { children: childPartials },
      timeoutMs: positive(timeLeft(), rootEntry),
      what: 'merging the frames of the audit (axe.finishRun)',
    })
    if (finished.missing) {
      throw new ModelFacingError(`audit: ${describeFrame(rootEntry)} navigated while it was being audited. Call audit() again once it has loaded.`)
    }
    crossResults = finished
  }

  const observation = await deps.observeQuietly(page)
  const placed = await placeNodes({ audited, crossResults, observation, rootEntry })

  const rules = auditCatalog().rules
  const violations = new Map<string, AuditRule>()
  const incomplete = new Map<string, AuditRule>()
  const status = new Map<string, 'passed' | 'inapplicable'>()
  const addRules = (into: Map<string, AuditRule>, slimRules: SlimRule[], frameOf: (node: SlimNode) => AuditedFrame | undefined): void => {
    for (const slim of slimRules) {
      const meta = rules.get(slim.id)
      const rule = into.get(slim.id) ?? {
        id: slim.id,
        impact: null,
        help: meta?.help ?? slim.id,
        description: meta?.description ?? '',
        helpUrl: meta?.helpUrl ?? '',
        tags: meta?.tags ?? [],
        source: meta?.source ?? 'axe',
        nodes: [],
      }
      for (const node of slim.nodes) rule.nodes.push(placed.render(node, frameOf(node)))
      rule.impact = maxImpact([rule.impact, slim.impact, ...slim.nodes.map((node) => node.impact)])
      into.set(slim.id, rule)
    }
  }
  const frameByPrefix = new Map(audited.map((frame) => [JSON.stringify(frame.prefix), frame]))
  for (const frame of audited) {
    if (!frame.local) continue
    addRules(violations, frame.local.violations, () => frame)
    addRules(incomplete, frame.local.incomplete, () => frame)
    for (const id of frame.local.passes) if (status.get(id) !== 'passed') status.set(id, 'passed')
    for (const id of frame.local.inapplicable) if (!status.has(id)) status.set(id, 'inapplicable')
  }
  if (crossResults) {
    const frameOf = (node: SlimNode): AuditedFrame | undefined => frameByPrefix.get(JSON.stringify(node.target.slice(0, -1)))
    addRules(violations, crossResults.violations, frameOf)
    addRules(incomplete, crossResults.incomplete, frameOf)
    for (const id of crossResults.passes) status.set(id, 'passed')
    for (const id of crossResults.inapplicable) if (!status.has(id)) status.set(id, 'inapplicable')
  }
  if (runsClickable) {
    const clickable = await clickableProblems({ observation, audited, inScope, element })
    if (clickable.nodes.length > 0) violations.set(CLICKABLE_RULE.id, clickable.rule)
    else status.set(CLICKABLE_RULE.id, clickable.candidates > 0 ? 'passed' : 'inapplicable')
  }
  for (const id of [...violations.keys(), ...incomplete.keys()]) status.delete(id)

  const report: AuditReport = {
    url: page.url(),
    axeVersion: version,
    scope: element ? element.target.ref : 'page',
    frames: audited.map((frame) => ({ url: frame.entry.url, elements: frame.elements, ms: frame.ms })),
    notAudited,
    elements: audited.reduce((sum, frame) => sum + frame.elements, 0),
    ms: Date.now() - startedAt,
    violations: sortRules([...violations.values()]),
    incomplete: sortRules([...incomplete.values()]),
    passed: [...status].filter(([, value]) => value === 'passed').map(([id]) => id).sort(),
    inapplicable: [...status].filter(([, value]) => value === 'inapplicable').map(([id]) => id).sort(),
    notRun: selection.notRun,
    text: '',
  }
  report.text = renderAudit(report, element ? `[${element.target.ref}] ${element.target.role}${element.target.name ? ` ${quote(element.target.name)}` : ''}` : null)
  return report
}

function positive(ms: number, entry: FrameEntry): number {
  if (ms > 0) return ms
  throw new ModelFacingError(
    `audit: no time left in this execute call to audit ${describeFrame(entry)}. Give execute a larger timeout (e.g. 60000), or audit less: audit({ ref }) for one part of the page, audit({ rules: [...] }) for some rules.`,
  )
}

function describeFrame(entry: FrameEntry): string {
  return entry.parentId === null ? `the page ${entry.url}` : `the iframe ${entry.url || entry.name || entry.frameId}`
}

async function ensureAxe(entry: FrameEntry, timeLeftMs: number): Promise<void> {
  const timeoutMs = positive(timeLeftMs, entry)
  const loaded = await entry.world.evaluate<string>(AXE_VERSION_EXPRESSION, { timeoutMs, what: `checking for axe-core in ${describeFrame(entry)}` })
  if (loaded) return
  await entry.world.evaluate<string>(`${axeSourceText()}\n;${INSTALL_SOURCE}`, { timeoutMs, what: `loading axe-core into ${describeFrame(entry)}` })
}

/** The frame `entry` is `rootId` or inside it. */
function isUnder(entry: { frameId: string }, rootId: string, frames: FrameEntry[], unreadable: UnreadableFrame[]): boolean {
  const parents = new Map<string, string | null>([...frames, ...unreadable].map((frame) => [frame.frameId, frame.parentId]))
  for (let id: string | null = entry.frameId; id !== null; id = parents.get(id) ?? null) if (id === rootId) return true
  return false
}

function outOfTime(error: PageUnresponsiveError, audited: AuditedFrame[], startedAt: number): ModelFacingError {
  const done = audited.map((frame) => `${frame.entry.url} (${frame.elements} elements, ${frame.ms} ms)`).join(', ')
  return new ModelFacingError(
    `audit: ran out of time after ${Math.round((Date.now() - startedAt) / 100) / 10} s — ${error.message} ` +
      `${done ? `Audited before that: ${done}. ` : ''}axe keeps running in the page until it finishes; the next audit() of that frame waits for it. ` +
      'Give execute a larger timeout (e.g. 120000), or audit less: audit({ ref }) for one part of the page, audit({ rules: [...] }) for some rules.',
    { cause: error },
  )
}

function maxImpact(impacts: Array<AuditImpact | null>): AuditImpact | null {
  for (const impact of IMPACT_ORDER) if (impacts.includes(impact)) return impact
  return null
}

function sortRules(rules: AuditRule[]): AuditRule[] {
  const rank = (impact: AuditImpact | null): number => (impact === null ? IMPACT_ORDER.length : IMPACT_ORDER.indexOf(impact))
  return rules.sort((a, b) => rank(a.impact) - rank(b.impact) || a.id.localeCompare(b.id))
}

/** The element as observe names it (`[4] button "Delete" (in row "Alice")`), `(unnamed)` when it has no name, and the address of an image without alt. */
function elementLabel(element: ObservedElement): string {
  const context = element.context ? ` (${element.context})` : ''
  const head = shortElement({ ...element, context: undefined })
  if (element.noAlt) return `${head} (no alt) ${quote(element.noAlt.src, 120)}${context}`
  return `${head}${element.name ? '' : ' (unnamed)'}${context}`
}

function markup(html: string): string {
  const clean = html.replace(/\s+/g, ' ').trim()
  return clean.length <= MAX_MARKUP_SHOWN ? clean : `${clean.slice(0, MAX_MARKUP_SHOWN - 1)}…`
}

/**
 * Place every reported node among the elements the observation lists in its frame (one call per
 * frame), and turn report nodes into `AuditNode`s.
 */
async function placeNodes({
  audited,
  crossResults,
  observation,
  rootEntry,
}: {
  audited: AuditedFrame[]
  crossResults: SlimResults | null
  observation: Observation
  rootEntry: FrameEntry
}): Promise<{ render: (node: SlimNode, frame: AuditedFrame | undefined) => AuditNode }> {
  const byPrefix = new Map(audited.map((frame) => [JSON.stringify(frame.prefix), frame]))
  /** A node's key in its frame: where the world keeps it (axe.run), or axe's selector (finishRun). */
  const keyOf = (node: SlimNode): string | undefined => {
    if (node.index !== undefined) return `i${node.index}`
    const local = node.target.at(-1)
    return local === undefined ? undefined : `s${JSON.stringify(local)}`
  }
  const wanted = new Map<AuditedFrame, { indexes: number[]; selectors: Map<string, string | string[]> }>()
  const want = (frame: AuditedFrame | undefined, node: SlimNode): void => {
    if (!frame) return
    const entry = wanted.get(frame) ?? { indexes: [], selectors: new Map<string, string | string[]>() }
    const local = node.target.at(-1)
    if (node.index !== undefined) entry.indexes.push(node.index)
    else if (local !== undefined) entry.selectors.set(`s${JSON.stringify(local)}`, local)
    wanted.set(frame, entry)
  }
  for (const frame of audited) {
    for (const rule of [...(frame.local?.violations ?? []), ...(frame.local?.incomplete ?? [])]) for (const node of rule.nodes) want(frame, node)
  }
  for (const rule of [...(crossResults?.violations ?? []), ...(crossResults?.incomplete ?? [])]) {
    for (const node of rule.nodes) want(byPrefix.get(JSON.stringify(node.target.slice(0, -1))), node)
  }
  const placements = new Map<AuditedFrame, { byKey: Map<string, Placement>; listed: ObservedElement[] }>()
  for (const [frame, { indexes, selectors }] of wanted) {
    const listed = observation.elements.filter((candidate) => candidate.frameId === frame.entry.frameId)
    const answers = await frame.entry.world.callFunctionOnNodes<{ byIndex: Placement[]; bySelector: Placement[] }>(
      listed.map((candidate) => candidate.backendNodeId),
      PLACE_FN,
      { args: { indexes, selectors: [...selectors.values()] }, what: `finding the refs of the elements axe reported in ${describeFrame(frame.entry)}` },
    )
    const byKey = new Map<string, Placement>()
    indexes.forEach((position, index) => byKey.set(`i${position}`, answers.byIndex[index] ?? { gone: true }))
    ;[...selectors.keys()].forEach((key, index) => byKey.set(key, answers.bySelector[index] ?? { gone: true }))
    placements.set(frame, { byKey, listed })
  }
  const render = (node: SlimNode, frame: AuditedFrame | undefined): AuditNode => {
    const key = keyOf(node)
    const placed = frame && key !== undefined ? placements.get(frame) : undefined
    const placement = placed && key !== undefined ? placed.byKey.get(key) : undefined
    const found = placed && placement ? { placement, listed: placed.listed } : undefined
    const exact = found?.placement.exact === undefined ? undefined : found.listed[found.placement.exact]
    const inside = found?.placement.inside === undefined ? undefined : found.listed[found.placement.inside]
    const where = frame && frame.entry !== rootEntry ? ` · in iframe ${frame.entry.url}` : ''
    const label = exact
      ? elementLabel(exact)
      : `${markup(node.html)}${inside ? ` inside ${elementLabel(inside)}` : ''}${found?.placement.gone ? ' (no longer on the page)' : ''}`
    return {
      ...(exact ? { ref: exact.ref } : {}),
      ...(inside ? { insideRef: inside.ref } : {}),
      ...(found?.placement.gone ? { gone: true as const } : {}),
      label: `${label}${where}`,
      frameUrl: frame ? frame.entry.url : '',
      selector: node.target,
      html: node.html,
      impact: node.impact,
      messages: node.messages,
      related: node.related,
    }
  }
  return { render }
}

/**
 * `clickable-without-keyboard`: the observation's `clickable` elements (no control role) that
 * Chromium reports clickable, in the audited frames (and inside the ref's element, for a ref).
 */
async function clickableProblems({
  observation,
  audited,
  inScope,
  element,
}: {
  observation: Observation
  audited: AuditedFrame[]
  inScope: Set<string>
  element: { target: { frameId: string; backendNodeId: number } } | null
}): Promise<{ rule: AuditRule; nodes: AuditNode[]; candidates: number }> {
  let candidates = observation.elements.filter((candidate) => candidate.role === 'clickable' && candidate.actionable?.clicks && inScope.has(candidate.frameId))
  if (element) {
    const rootFrame = audited[0]
    const inRoot = candidates.filter((candidate) => candidate.frameId === element.target.frameId)
    const inside = inRoot.length === 0
      ? []
      : await rootFrame.entry.world.callFunctionOnNodes<boolean[]>([element.target.backendNodeId, ...inRoot.map((candidate) => candidate.backendNodeId)], CONTAINS_FN, {
          what: 'finding the clickable elements inside the audited element',
        })
    const outside = new Set(inRoot.filter((_candidate, index) => !inside[index]))
    candidates = candidates.filter((candidate) => !outside.has(candidate))
  }
  const urlOf = new Map(audited.map((frame) => [frame.entry.frameId, frame.entry.url]))
  const nodes: AuditNode[] = []
  for (const candidate of candidates) {
    const message = candidate.actionable?.focusable
      ? 'It responds to clicks and Tab reaches it, but it has no control role: screen readers announce it as plain text, not as a button or link'
      : 'It responds to clicks but is not focusable (no tabindex, not a control): keyboard users cannot reach or activate it'
    const frameUrl = urlOf.get(candidate.frameId) ?? ''
    nodes.push({
      ref: candidate.ref,
      label: `${elementLabel(candidate)}${candidate.frameId !== audited[0].entry.frameId ? ` · in iframe ${frameUrl}` : ''}`,
      frameUrl,
      selector: [],
      html: candidate.cssLabel ?? candidate.tag,
      impact: 'serious',
      messages: [message],
      related: [],
    })
  }
  return {
    rule: {
      id: CLICKABLE_RULE.id,
      impact: nodes.length > 0 ? 'serious' : null,
      help: CLICKABLE_RULE.help,
      description: CLICKABLE_RULE.description,
      helpUrl: CLICKABLE_RULE.helpUrl,
      tags: CLICKABLE_RULE.tags,
      source: 'playwriter',
      nodes,
    },
    nodes,
    candidates: candidates.length,
  }
}

function renderRules(rules: AuditRule[], kind: 'violations' | 'incomplete'): string[] {
  const lines: string[] = []
  for (const rule of rules) {
    const ours = rule.source === 'playwriter' ? ' (playwriter check)' : ''
    lines.push(`[${rule.impact ?? 'needs review'}] ${rule.id}${ours} — ${rule.help} — ${rule.helpUrl}`)
    for (const node of rule.nodes.slice(0, MAX_NODES_SHOWN)) {
      const why = node.messages[0] ? ` — ${node.messages[0]}` : ''
      const more = node.messages.length > 1 ? ` (+${node.messages.length - 1} more in its .messages)` : ''
      lines.push(`  ${node.label}${why}${more}`)
    }
    const hidden = rule.nodes.length - MAX_NODES_SHOWN
    if (hidden > 0) lines.push(`  … +${hidden} more elements: every one is in the value audit() returns, .${kind}.find((rule) => rule.id === '${rule.id}').nodes`)
  }
  return lines
}

function renderAudit(report: AuditReport, scopeLabel: string | null): string {
  const seconds = (ms: number): string => `${Math.round(ms / 100) / 10} s`
  const frameWord = report.frames.length === 1 ? 'frame' : 'frames'
  const lines = [
    `AUDIT ${report.url}${scopeLabel ? ` — only ${scopeLabel}` : ''} · axe-core ${report.axeVersion} + playwriter checks · ` +
      `${report.frames.length} ${frameWord}, ${report.elements} elements checked by axe in ${seconds(report.frames.reduce((sum, frame) => sum + frame.ms, 0))} ` +
      `(${seconds(report.ms)} in all, with placing them among observe's refs)`,
  ]
  if (report.frames.length > 1) {
    for (const frame of report.frames) lines.push(`  frame ${frame.url}: ${frame.elements} elements, ${frame.ms} ms`)
  }
  const violating = report.violations.reduce((sum, rule) => sum + rule.nodes.length, 0)
  lines.push(
    report.violations.length === 0
      ? 'VIOLATIONS: none found by the rules that ran.'
      : `VIOLATIONS: ${report.violations.length} rule${report.violations.length === 1 ? '' : 's'} failed on ${violating} element${violating === 1 ? '' : 's'}, most severe first:`,
  )
  lines.push(...renderRules(report.violations, 'violations'))
  if (report.incomplete.length > 0) {
    lines.push("NEEDS REVIEW — axe could not decide these (check each yourself, e.g. with explain(ref) or a screenshot):")
    lines.push(...renderRules(report.incomplete, 'incomplete'))
  }
  lines.push(`Passed: ${report.passed.length} rules · nothing to check: ${report.inapplicable.length} rules.`)
  if (report.notAudited.length > 0) {
    lines.push('NOT AUDITED:')
    for (const frame of report.notAudited) lines.push(`  iframe ${frame.url} — ${frame.reason}`)
  }
  if (report.notRun.length > 0) {
    const groups = new Map<string, string[]>()
    for (const entry of report.notRun) groups.set(entry.why, [...(groups.get(entry.why) ?? []), entry.id])
    lines.push(`NOT RUN: ${[...groups].map(([why, ids]) => `${ids.join(', ')} (${why})`).join('; ')}. Run one by name: audit({ rules: ['<id>'] }).`)
  }
  return lines.join('\n')
}
