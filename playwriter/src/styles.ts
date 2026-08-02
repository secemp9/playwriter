import type { ICDPSession } from './cdp-session.js'
import type { Locator } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { computeSpecificity, compareSpecificity, type NormalizedRule, type Specificity } from './css-cascade.js'

export interface StyleSource {
  url: string
  line: number
  column: number
}

export type StyleDeclarations = Record<string, string>

export interface StyleRule {
  selector: string
  source: StyleSource | null
  origin: 'regular' | 'user-agent' | 'injected' | 'inspector'
  declarations: StyleDeclarations
  inheritedFrom: string | null
  /**
   * Declarations the rule DOES contain that `declarations` does not, as
   * `"name: value — reason"`. Present only when something was dropped.
   *
   * `initial` values and `-webkit-` prefixed properties are filtered out on purpose, but
   * silently: `declarations` looked like the rule's whole content, so a real
   * `-webkit-line-clamp: 2` that Chrome does report simply had no representation
   * anywhere in the result.
   */
  droppedDeclarations?: string[]
}

export interface StylesResult {
  element: string
  inlineStyle: StyleDeclarations | null
  rules: StyleRule[]
}

interface CSSProperty {
  name: string
  value: string
  important?: boolean
}

interface CSSStyle {
  cssProperties: CSSProperty[]
  cssText?: string
}

interface CSSSelector {
  text: string
  /** Where this ONE selector starts in its stylesheet. Absent for user-agent rules. */
  range?: SourceRange
}

interface CSSRule {
  /**
   * `range` on the list itself is NOT sent by current Chromium — see `selectorRangeFor`.
   * It is typed as optional only so the legacy read can stay as a fallback.
   */
  selectorList: { text: string; selectors?: CSSSelector[]; range?: SourceRange }
  style: CSSStyle
  styleSheetId?: string
  origin: string
}

interface RuleMatch {
  rule: CSSRule
  matchingSelectors: number[]
}

interface InheritedStyleEntry {
  inlineStyle?: CSSStyle
  matchedCSSRules: RuleMatch[]
}

interface SourceRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

interface CSSStyleSheetHeader {
  styleSheetId: string
  sourceURL?: string
  origin: string
}

/**
 * Where a matched rule's selector starts in its stylesheet.
 *
 * MEASURED against Chromium 145.0.7632.18: the range lives on each ENTRY of
 * `selectorList.selectors`, and `selectorList.range` does not exist. Dumping a matched
 * rule for `.b` in an external sheet gives
 * `selectorList.selectors[0].range = {startLine:1,startColumn:0,endLine:1,endColumn:2}`
 * while `selectorList.range` is `undefined` — on every rule of every origin tested
 * (external `<link>`, inline `<style>`, user-agent).
 *
 * This module used to read `selectorList.range` and nothing else, so `sourceRange` was
 * `undefined` for EVERY rule and `source` was therefore `null` for every rule. Both
 * consumers degrade silently on a null source: `formatStylesAsText` prints no
 * `/* url:line:col *\/` comment and `css-cascade.ts`'s `formatSourceComment` returns
 * `''` — so `debugStyle`, whose entire purpose is naming which rule in which file won,
 * reported no file for anything and looked like a stylesheet that simply had no sources.
 *
 * The MATCHED selector's range is used, not `selectors[0]`'s: for
 * `.no-match-a, #target, div.no-match-b` the interesting position is `#target`'s, the
 * same selector `specificityForRule` scores. `selectors[0]` is the fallback when the
 * match indexes are absent, and `selectorList.range` remains the last fallback so a
 * Chromium that does send it keeps working.
 *
 * User-agent rules carry no range at all (measured: every one of the 53 selectors in
 * the big UA `div, p, …` rule has `range: undefined`), which is correct — they have no
 * authored source — and `source` stays null for them.
 */
function selectorRangeFor(rule: CSSRule, matchingSelectors?: number[]): SourceRange | undefined {
  const selectors = rule.selectorList?.selectors
  if (Array.isArray(selectors) && selectors.length > 0) {
    const matchedIndex = Array.isArray(matchingSelectors) && matchingSelectors.length > 0 ? matchingSelectors[0] : 0
    const range = selectors[matchedIndex]?.range ?? selectors[0]?.range
    if (range) return range
  }
  return rule.selectorList?.range
}

/**
 * Every stylesheet header seen so far, keyed by `styleSheetId`.
 *
 * Module-level rather than per-session on purpose, and it is not a shortcut: a
 * `styleSheetId` is unique across the browser process (Chromium 145 issues them as
 * `style-sheet-<pid-ish counter>-<n>`, e.g. `style-sheet-1024378-1`), so two sessions
 * cannot collide in this map. Per-session was not an option: `getCDPSessionForPage`
 * mints a NEW `PlaywrightCDPSessionAdapter` on every call — executor.ts documents this
 * and keeps its own per-page cache for exactly that reason — so a `WeakMap` keyed on the
 * `ICDPSession` handed to us would miss on literally every call after the first.
 */
const styleSheetHeadersById = new Map<string, CSSStyleSheetHeader>()

/** Bound on the above, so a long-lived SPA that keeps injecting `<style>` cannot grow it forever. */
const MAX_TRACKED_STYLESHEETS = 5000

/**
 * Enable the CSS domain and collect the stylesheet headers, which is the only way to
 * learn a rule's real source URL.
 *
 * MEASURED against Chromium 145.0.7632.18: `CSS.getMatchedStylesForNode` does NOT carry a
 * `cssStyleSheetHeaders` field. The response keys are exactly `inlineStyle`,
 * `matchedCSSRules`, `pseudoElements`, `inherited`, `inheritedPseudoElements`,
 * `cssKeyframesRules`, `cssPropertyRules`, `cssPropertyRegistrations`, `cssAtRules`,
 * `parentLayoutNodeId` — with an external `<link>`, an inline `<style>`, or both. The
 * comment this replaces said Chrome "has sent it for years" and treated its absence as a
 * hypothetical; absent is what it actually is, so EVERY rule was falling back to
 * `stylesheet:<id>` and no real URL was ever reported.
 *
 * The headers do arrive, as events: `CSS.enable` REPLAYS `CSS.styleSheetAdded` for every
 * already-parsed sheet. Measured on a page loaded BEFORE either domain was enabled, two
 * events arrive carrying `sourceURL: 'http://.../s.css'` (isInline false) and
 * `sourceURL: 'http://.../'` (isInline true, the `<style>` block), and their
 * `styleSheetId`s are the same ids the matched rules reference.
 *
 * KNOWN LIMIT, stated rather than papered over: the replay only happens on the enable
 * that actually turns the domain on. A second call on a session where CSS is already
 * enabled receives nothing new, which is why the headers are accumulated in a map that
 * outlives the call instead of being collected fresh each time. A stylesheet added while
 * the domain was enabled but no style call was in flight is therefore not in the map, and
 * its rules report `stylesheet:<id>`. That degrades to the old behaviour for those rules;
 * it never reports a WRONG url. `CSS.disable`+`CSS.enable` would force a full replay and
 * is deliberately not done — this is Playwright's own shared page session, and the same
 * move on the Runtime domain is what makes V8 replay the whole console buffer (see
 * `Debugger.enable` in debugger.ts).
 */
async function enableCssCollectingHeaders(cdp: ICDPSession): Promise<CSSStyleSheetHeader[]> {
  const onAdded = (event: Protocol.CSS.StyleSheetAddedEvent): void => {
    if (styleSheetHeadersById.size >= MAX_TRACKED_STYLESHEETS) return
    styleSheetHeadersById.set(event.header.styleSheetId, event.header as unknown as CSSStyleSheetHeader)
  }
  // Registered BEFORE the enable so the replay is caught, and removed after so repeated
  // style calls cannot pile listeners onto the shared underlying Playwright session.
  cdp.on('CSS.styleSheetAdded', onAdded)
  try {
    await cdp.send('CSS.enable')
  } finally {
    cdp.off('CSS.styleSheetAdded', onAdded)
  }
  return [...styleSheetHeadersById.values()]
}

// ---------------------------------------------------------------------------
// Element identity: locator -> CDP node
// ---------------------------------------------------------------------------

/**
 * One tree the element path passes through. `enter` says how the tree is entered from
 * the previous hop: `document` = the top-level document, `frame` = the content document
 * of the iframe element the previous hop resolved, `shadow` = the shadow root of the
 * host element the previous hop resolved. `path` is the chain of 0-based *element*
 * child indexes to follow inside that tree.
 */
export interface ElementPathHop {
  enter: 'document' | 'shadow' | 'frame'
  path: number[]
}

export interface ElementPathResult {
  hops: ElementPathHop[]
  /** Lowercased tag name of the target, used to verify the walk landed on it. */
  tagName: string
  /** Set when the path cannot be expressed, e.g. a detached or cross-origin element. */
  error?: string
}

/**
 * Compute an element's exact position in its tree, as index paths split at shadow-root
 * and iframe boundaries.
 *
 * This runs IN THE PAGE (it is stringified by `evaluate`), so it must stay entirely
 * self-contained: no imports, no closure over module scope, no TypeScript-only syntax
 * that would not survive `String(fn)`.
 *
 * This is identity, not geometry: the walk starts at the element itself, so nothing that
 * happens to be painted on top of it can change the answer.
 */
export function computeElementPath(element: any): ElementPathResult {
  const hops: Array<{ enter: 'document' | 'shadow' | 'frame'; path: number[] }> = []
  const tagName = String(element.tagName || '').toLowerCase()
  let node: any = element
  let path: number[] = []
  let guard = 0

  const elementIndexIn = (parent: any, child: any): number => {
    const children = parent.children
    for (let i = 0; i < children.length; i++) {
      if (children[i] === child) return i
    }
    return -1
  }

  while (guard++ < 10000) {
    const parentElement = node.parentElement
    if (parentElement) {
      const index = elementIndexIn(parentElement, node)
      if (index < 0) return { hops: [], tagName, error: 'element is not among its parent element children' }
      path.unshift(index)
      node = parentElement
      continue
    }

    const root = node.getRootNode ? node.getRootNode() : node.parentNode
    if (root && root.nodeType === 11 && root.host) {
      // Shadow root: index among the shadow root's own element children, then hop to the
      // host and keep walking in the outer tree.
      const index = elementIndexIn(root, node)
      if (index < 0) return { hops: [], tagName, error: 'element is not among its shadow root children' }
      path.unshift(index)
      hops.unshift({ enter: 'shadow', path })
      path = []
      node = root.host
      continue
    }

    if (root && root.nodeType === 9) {
      // Document. `node` is the document element, whose own index is implied by starting
      // the hop at the document element, so it contributes no index.
      let frameElement: any = null
      try {
        frameElement = root.defaultView ? root.defaultView.frameElement : null
      } catch {
        // Cross-origin parent: the frame element is unreachable from here, and so is any
        // node id for it on this CDP session.
        return { hops: [], tagName, error: 'element is inside a cross-origin iframe' }
      }
      hops.unshift({ enter: frameElement ? 'frame' : 'document', path })
      if (!frameElement) return { hops, tagName }
      path = []
      node = frameElement
      continue
    }

    return { hops: [], tagName, error: 'element is detached from any document' }
  }
  return { hops: [], tagName, error: 'element ancestor chain exceeded 10000 steps' }
}

async function describeElementPath(elementHandle: any): Promise<ElementPathResult> {
  return (await elementHandle.evaluate(computeElementPath)) as ElementPathResult
}

/** The element children of a CDP node, in document order. */
function elementChildren(node: Protocol.DOM.Node): Protocol.DOM.Node[] {
  return (node.children ?? []).filter((child) => child.nodeType === 1)
}

/** The document element of a CDP document node. */
function documentElementOf(document: Protocol.DOM.Node): Protocol.DOM.Node {
  const element = elementChildren(document)[0]
  if (!element) {
    throw new Error('Could not resolve element: document node has no document element in the CDP tree')
  }
  return element
}

/**
 * Resolve a locator to the CDP node it actually points at.
 *
 * Why not `DOM.getNodeForLocation`: that returns the TOPMOST node at a screen point, so
 * anything covering the element — a modal, a sticky header, or just a child span holding
 * the label — silently resolves to a *different* node, and every rule, cascade winner
 * and source location reported afterwards then belongs to the wrong element. MEASURED
 * against Chromium 145: over two absolutely-positioned 200x200 divs stacked at the same
 * origin, `getNodeForLocation({x:50,y:50})` returns the LATER-painted one (`#over`), never
 * the one underneath. That is the exact failure `debugStyle` exists to diagnose, so
 * identity is resolved through the element's own node instead: the page reports the
 * element's index path, and the path is walked over one pierced `DOM.getDocument` tree.
 * The final node's tag name is verified against the page's, so a DOM mutation racing the
 * walk fails loudly instead of answering about a neighbour.
 *
 * `DOM.getDocument` doubles as the priming call CDP requires before FRONTEND node ids can
 * be handed out on a fresh session — measured: `DOM.pushNodesByBackendIdsToFrontend` on a
 * session with `DOM.enable` but no `DOM.getDocument` is rejected with "Document needs to
 * be requested first" — which is why both style entry points share this helper rather than
 * each remembering to prime. (`DOM.getNodeForLocation` is NOT subject to that rule: the
 * same measurement had it answer with no `DOM.getDocument` and indeed with no `DOM.enable`
 * at all. It returns a backendNodeId, not a frontend one.)
 */
export async function resolveElementNode({
  locator,
  cdp,
}: {
  locator: Locator
  cdp: ICDPSession
}): Promise<{ nodeId: number; backendNodeId: number; node: Protocol.DOM.Node }> {
  await cdp.send('DOM.enable')
  const elementHandle = await locator.elementHandle()
  if (!elementHandle) {
    throw new Error('Could not get element handle from locator')
  }
  const described = await describeElementPath(elementHandle)
  if (described.error) {
    throw new Error(`Could not resolve element identity over CDP: ${described.error}`)
  }

  // `pierce: true` brings shadow roots and same-process iframe content documents into
  // the one tree, which is what makes the hop walk below possible in a single round-trip.
  // MEASURED against Chromium 145 on a page with an open shadow root and a srcdoc iframe:
  // with `pierce: true` the returned tree contains both the shadow child and the iframe's
  // `<p>`; with `pierce: false` it contains neither.
  const { root } = (await cdp.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  })) as Protocol.DOM.GetDocumentResponse

  let current: Protocol.DOM.Node | null = null
  for (const hop of described.hops) {
    let treeRoot: Protocol.DOM.Node
    if (hop.enter === 'document') {
      treeRoot = documentElementOf(root)
    } else if (hop.enter === 'frame') {
      const contentDocument = current?.contentDocument
      if (!contentDocument) {
        throw new Error(
          `Could not resolve element: <${current?.nodeName?.toLowerCase() ?? '?'}> has no content document on this CDP ` +
            'session (a cross-process iframe needs its own session)',
        )
      }
      treeRoot = documentElementOf(contentDocument)
    } else {
      // Prefer an author shadow root; a user-agent one belongs to the browser's own
      // internals and never contains the element the page handed us. Not hypothetical:
      // MEASURED against Chromium 145, `DOM.getDocument({ pierce: true })` reports an
      // `<input type=range>` with `shadowRoots: [{ shadowRootType: 'user-agent' }]`, so an
      // unfiltered `shadowRoots[0]` would walk into the slider's internals.
      const shadowRoot = (current?.shadowRoots ?? []).find((sr) => sr.shadowRootType !== 'user-agent')
      if (!shadowRoot) {
        throw new Error(
          `Could not resolve element: <${current?.nodeName?.toLowerCase() ?? '?'}> has no author shadow root in the CDP tree`,
        )
      }
      treeRoot = shadowRoot
    }

    current = treeRoot
    for (const index of hop.path) {
      const children = elementChildren(current)
      const next = children[index]
      if (!next) {
        throw new Error(
          `Could not resolve element: child index ${index} does not exist under <${current.nodeName.toLowerCase()}> ` +
            '(the DOM changed while resolving)',
        )
      }
      current = next
    }
  }

  if (!current) {
    throw new Error('Could not resolve element: empty element path')
  }
  const resolvedTag = current.nodeName.toLowerCase()
  if (described.tagName && resolvedTag !== described.tagName) {
    throw new Error(
      `Could not resolve element: the path resolved to <${resolvedTag}> but the locator points at ` +
        `<${described.tagName}> — the DOM changed while resolving`,
    )
  }
  if (!current.nodeId) {
    throw new Error(`Could not resolve element: <${resolvedTag}> has no frontend nodeId`)
  }
  return { nodeId: current.nodeId, backendNodeId: current.backendNodeId, node: current }
}

export async function getStylesForLocator({
  locator,
  cdp: cdpSession,
  includeUserAgentStyles = false,
}: {
  locator: Locator
  cdp: ICDPSession
  includeUserAgentStyles?: boolean
}): Promise<StylesResult> {
  const cdp = cdpSession
  // DOM before CSS, and it is a hard requirement, not a convention: MEASURED against
  // Chromium 145, `CSS.enable` on a session with no prior `DOM.enable` is rejected with
  // the protocol error "DOM agent needs to be enabled first". resolveElementNode enables
  // DOM too, but it runs after this point, and CSS.enable has to stay early — it only
  // starts tracking stylesheets from the moment it is sent.
  await cdp.send('DOM.enable')
  const collectedHeaders = await enableCssCollectingHeaders(cdp)

  const { nodeId, node } = await resolveElementNode({ locator, cdp })
  const elementDescription = formatElementDescription(node)

  const matchedStyles = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
  // The response's own field first (older Chromium sent one), then the headers replayed
  // across `CSS.enable` — see `enableCssCollectingHeaders` for why current Chromium sends
  // no field at all. Absent both, every rule falls back to `stylesheet:<id>`.
  const styleSheetHeaders =
    ((matchedStyles as any).cssStyleSheetHeaders as CSSStyleSheetHeader[] | undefined) ?? collectedHeaders

  const rules: StyleRule[] = []

  if (matchedStyles.matchedCSSRules) {
    for (const ruleMatch of matchedStyles.matchedCSSRules) {
      const rule = ruleMatch.rule
      const sourceRange = selectorRangeFor(rule as unknown as CSSRule, ruleMatch.matchingSelectors)
      const styleSheetId = rule.styleSheetId

      let source: StyleSource | null = null
      if (styleSheetId && sourceRange) {
        source = {
          url: stylesheetUrlFor(styleSheetHeaders, styleSheetId, rule.origin),
          line: sourceRange.startLine + 1,
          column: sourceRange.startColumn,
        }
      }

      const { declarations, dropped } = extractDeclarationsWithDrops(rule.style)
      rules.push({
        selector: rule.selectorList.text,
        source,
        origin: rule.origin as StyleRule['origin'],
        declarations,
        inheritedFrom: null,
        ...(dropped.length ? { droppedDeclarations: dropped } : {}),
      })
    }
  }

  if (matchedStyles.inherited) {
    for (let i = 0; i < matchedStyles.inherited.length; i++) {
      const inheritedEntry = matchedStyles.inherited[i] as InheritedStyleEntry
      const ancestorDesc = `ancestor[${i + 1}]`

      if (inheritedEntry.inlineStyle) {
        const declarations = extractDeclarations(inheritedEntry.inlineStyle)
        if (Object.keys(declarations).length > 0) {
          rules.push({
            selector: 'element.style',
            source: null,
            origin: 'regular',
            declarations,
            inheritedFrom: ancestorDesc,
          })
        }
      }

      for (const ruleMatch of inheritedEntry.matchedCSSRules) {
        const rule = ruleMatch.rule
        const sourceRange = selectorRangeFor(rule, ruleMatch.matchingSelectors)
        const styleSheetId = rule.styleSheetId

        let source: StyleSource | null = null
        if (styleSheetId && sourceRange) {
          source = {
            url: stylesheetUrlFor(styleSheetHeaders, styleSheetId, rule.origin),
            line: sourceRange.startLine + 1,
            column: sourceRange.startColumn,
          }
        }

        const declarations = extractDeclarations(rule.style)
        if (Object.keys(declarations).length > 0) {
          rules.push({
            selector: rule.selectorList.text,
            source,
            origin: rule.origin as StyleRule['origin'],
            declarations,
            inheritedFrom: ancestorDesc,
          })
        }
      }
    }
  }

  let inlineStyle: StyleDeclarations | null = null
  if (matchedStyles.inlineStyle) {
    const declarations = extractDeclarations(matchedStyles.inlineStyle as CSSStyle)
    if (Object.keys(declarations).length > 0) {
      inlineStyle = declarations
    }
  }

  const filteredRules = includeUserAgentStyles ? rules : rules.filter((r) => r.origin !== 'user-agent')

  return {
    element: elementDescription,
    inlineStyle,
    rules: filteredRules,
  }
}

/**
 * Convert a raw CDP `CSS.getMatchedStylesForNode` response into the
 * `NormalizedRule[]` shape `resolveCascade` (css-cascade.ts) expects. Pure and
 * synchronous: directly-matched rules first (in CDP application order), then the
 * inline style (ranked last). Inherited rules are intentionally excluded — under
 * the real cascade, inheritance only applies when nothing directly declares the
 * property, so mixing inherited declarations into the same specificity sort would
 * be incorrect. Preserves `source {url,line,column}`, `origin`, and `!important`
 * flags. `order` is the CDP order (later = wins the source-order tiebreak).
 */
export function normalizeMatchedStyles(matchedStyles: any): NormalizedRule[] {
  const rules: NormalizedRule[] = []
  const headers: CSSStyleSheetHeader[] = matchedStyles?.cssStyleSheetHeaders ?? []

  const urlFor = (styleSheetId: string | undefined, origin: string): string =>
    styleSheetId ? stylesheetUrlFor(headers, styleSheetId, origin) : origin === 'user-agent' ? 'user-agent' : ''

  let order = 0

  if (matchedStyles?.matchedCSSRules) {
    for (const ruleMatch of matchedStyles.matchedCSSRules as RuleMatch[]) {
      const rule = ruleMatch.rule
      const { declarations, important, dropped } = splitDeclarations(rule.style)
      if (Object.keys(declarations).length === 0) {
        continue
      }

      const sourceRange = selectorRangeFor(rule, ruleMatch.matchingSelectors)
      let source: StyleSource | null = null
      if (sourceRange) {
        source = {
          url: urlFor(rule.styleSheetId, rule.origin),
          line: sourceRange.startLine + 1,
          column: sourceRange.startColumn,
        }
      }

      rules.push({
        selector: rule.selectorList.text,
        specificity: specificityForRule(rule, ruleMatch.matchingSelectors),
        declarations,
        important,
        origin: rule.origin,
        source,
        order: order++,
        styleSheetId: rule.styleSheetId,
        ...(dropped.length ? { droppedDeclarations: dropped } : {}),
      })
    }
  }

  if (matchedStyles?.inlineStyle) {
    const { declarations, important, dropped } = splitDeclarations(matchedStyles.inlineStyle as CSSStyle)
    if (Object.keys(declarations).length > 0) {
      rules.push({
        selector: 'element.style',
        specificity: [0, 0, 0],
        declarations,
        important,
        origin: 'regular',
        source: null,
        inline: true,
        order: order++,
        ...(dropped.length ? { droppedDeclarations: dropped } : {}),
      })
    }
  }

  return rules
}

/**
 * Fetch and normalize the matched styles for a locator's element, returning the
 * `NormalizedRule[]` ready for `resolveCascade` plus the element's backendNodeId
 * and the raw CDP response (for callers that want stylesheet text / code-frames).
 * Additive helper — does not affect `getStylesForLocator`.
 */
export async function fetchNormalizedStyles({
  locator,
  cdp,
}: {
  locator: Locator
  cdp: ICDPSession
}): Promise<{ backendNodeId: number; nodeId: number; rules: NormalizedRule[]; matchedStyles: any }> {
  // DOM before CSS — see the note in getStylesForLocator; CSS.enable is rejected outright
  // ("DOM agent needs to be enabled first", measured) if the DOM agent has not been
  // enabled on this session yet.
  await cdp.send('DOM.enable')
  const collectedHeaders = await enableCssCollectingHeaders(cdp)
  // Identity comes from the element's own node, never from a point hit-test — see
  // `resolveElementNode`. It also performs the `DOM.getDocument` priming call CDP needs
  // before it will hand out node ids on a fresh session.
  const { nodeId, backendNodeId } = await resolveElementNode({ locator, cdp })

  const matchedStyles = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
  // `normalizeMatchedStyles` is pure and reads the headers off the response object, so
  // the ones replayed across `CSS.enable` are attached here rather than threaded through
  // a second parameter. Only filled in when Chromium sent no field of its own.
  if (!(matchedStyles as any).cssStyleSheetHeaders && collectedHeaders.length > 0) {
    ;(matchedStyles as any).cssStyleSheetHeaders = collectedHeaders
  }
  return { backendNodeId, nodeId, rules: normalizeMatchedStyles(matchedStyles), matchedStyles }
}

/**
 * Why a declaration was excluded from the cascade, or `null` to keep it.
 *
 * The single place the two filters live, so `splitDeclarations` and
 * `extractDeclarations` cannot drift apart — and so each drop can be REPORTED rather
 * than vanishing. Verified against Chromium that both cases occur in real matched
 * styles: `#ini { color: initial }` arrives as `color=initial` (plus its expanded
 * longhands), and `#wk { -webkit-line-clamp: 2 }` arrives as `-webkit-line-clamp=2`.
 */
function declarationDropReason(prop: CSSProperty): string | null {
  if (!prop.value) return 'empty value'
  if (prop.value === 'initial') {
    return "value is the `initial` keyword — Chrome's own longhand expansion, not an authored cascade input"
  }
  if (prop.name.startsWith('-webkit-')) {
    return '-webkit- prefixed property — excluded from the cascade as a vendor duplicate'
  }
  return null
}

/** Like `extractDeclarations` but keeps clean values + a separate `!important` set. */
function splitDeclarations(style: CSSStyle): {
  declarations: StyleDeclarations
  important: Set<string>
  dropped: string[]
} {
  const declarations: StyleDeclarations = {}
  const important = new Set<string>()
  const dropped: string[] = []
  if (!style?.cssProperties) {
    return { declarations, important, dropped }
  }
  for (const prop of style.cssProperties) {
    const reason = declarationDropReason(prop)
    if (reason) {
      dropped.push(`${prop.name}: ${prop.value ?? ''} — ${reason}`)
      continue
    }
    declarations[prop.name] = prop.value
    if (prop.important) {
      important.add(prop.name)
    }
  }
  return { declarations, important, dropped }
}

/**
 * Specificity of a matched rule, taking the MAX over just its matched selectors.
 *
 * `matchingSelectors` indexes into `selectorList.selectors` — verified against Chromium,
 * including the extreme case: a 53-selector user-agent rule reports `matchingSelectors:
 * [3]`, which is `'div'`, the selector that actually matched. So the index space is the
 * selector array's own, and the assumption this code was built on is correct.
 *
 * An out-of-range index is nonetheless a hard error rather than a skip. It used to be
 * `selectors[idx]?.text`, so a misalignment produced no selector, no specificity
 * contribution, and a final `[0, 0, 0]` — the rule then silently lost every specificity
 * contest and the cascade named the wrong winner, with nothing in the output saying why.
 * A cascade computed from an index space we do not understand is worse than no cascade.
 */
function specificityForRule(rule: CSSRule, matchingSelectors?: number[]): Specificity {
  const selectors = (rule as any).selectorList?.selectors as Array<{ text: string }> | undefined
  if (Array.isArray(selectors) && Array.isArray(matchingSelectors) && matchingSelectors.length > 0) {
    let best: Specificity = [0, 0, 0]
    for (const idx of matchingSelectors) {
      const text = selectors[idx]?.text
      if (typeof text !== 'string') {
        throw new Error(
          `normalizeMatchedStyles: matchingSelectors index ${idx} has no selector in a list of ${selectors.length} ` +
            `for rule "${rule.selectorList?.text ?? '(unknown)'}". matchingSelectors indexes selectorList.selectors; ` +
            `if it does not, every specificity computed here is attributed to the wrong selector and the cascade ` +
            `winner is wrong. Selectors: [${selectors.map((s) => s.text).join(', ')}]`,
        )
      }
      const spec = computeSpecificity(text)
      if (compareSpecificity(spec, best) > 0) {
        best = spec
      }
    }
    return best
  }
  return computeSpecificity(rule.selectorList?.text ?? '')
}

function extractDeclarations(style: CSSStyle): StyleDeclarations {
  return extractDeclarationsWithDrops(style).declarations
}

/** `extractDeclarations` plus the accounting for what the filters removed. */
function extractDeclarationsWithDrops(style: CSSStyle): { declarations: StyleDeclarations; dropped: string[] } {
  const declarations: StyleDeclarations = {}
  const dropped: string[] = []
  if (!style?.cssProperties) {
    return { declarations, dropped }
  }

  for (const prop of style.cssProperties) {
    const reason = declarationDropReason(prop)
    if (reason) {
      dropped.push(`${prop.name}: ${prop.value ?? ''} — ${reason}`)
      continue
    }
    declarations[prop.name] = prop.important ? `${prop.value} !important` : prop.value
  }
  return { declarations, dropped }
}

function formatElementDescription(node: any): string {
  let desc = node.localName || node.nodeName?.toLowerCase() || 'element'

  if (node.attributes) {
    const attrs: Record<string, string> = {}
    for (let i = 0; i < node.attributes.length; i += 2) {
      attrs[node.attributes[i]] = node.attributes[i + 1]
    }

    if (attrs.id) {
      desc += `#${attrs.id}`
    }
    if (attrs.class) {
      desc += `.${attrs.class.split(' ').join('.')}`
    }
  }

  return desc
}

/**
 * Where a matched rule comes from, out of the stylesheet headers CDP already sent with
 * the matched-styles response.
 *
 * This replaces a `CSS.getStyleSheetText` round-trip per rule whose *result was thrown
 * away* — it fetched the whole stylesheet text and returned `stylesheet:<id>` from both
 * the success and the catch path, so it cost N round-trips to compute a string that
 * needs none. The real `sourceURL` is right there in `cssStyleSheetHeaders`; the previous
 * attempt to read it was dead code with an `||`/ternary precedence bug
 * (`a || b === c ? x : y` parses as `(a || (b === c)) ? x : y`), so its value was
 * computed and then discarded.
 *
 * An inline `<style>` has no `sourceURL`; `stylesheet:<id>` is the honest fallback there
 * because the id is the only handle that identifies it.
 */
function stylesheetUrlFor(
  headers: CSSStyleSheetHeader[] | undefined,
  styleSheetId: string,
  origin: string | undefined,
): string {
  if (origin === 'user-agent') return 'user-agent'
  const header = headers?.find((h) => h.styleSheetId === styleSheetId)
  return header?.sourceURL || `stylesheet:${styleSheetId}`
}

export function formatStylesAsText(styles: StylesResult): string {
  const lines: string[] = []

  lines.push(`Element: ${styles.element}`)
  lines.push('')

  if (styles.inlineStyle) {
    lines.push('Inline styles:')
    for (const [prop, value] of Object.entries(styles.inlineStyle)) {
      lines.push(`  ${prop}: ${value}`)
    }
    lines.push('')
  }

  const directRules = styles.rules.filter((r) => !r.inheritedFrom)
  const inheritedRules = styles.rules.filter((r) => r.inheritedFrom)

  if (directRules.length > 0) {
    lines.push('Matched rules:')
    for (const rule of directRules) {
      lines.push(`  ${rule.selector} {`)
      const sourceInfo = rule.source ? ` /* ${rule.source.url}:${rule.source.line}:${rule.source.column} */` : ''
      if (sourceInfo) {
        lines.push(`   ${sourceInfo}`)
      }
      for (const [prop, value] of Object.entries(rule.declarations)) {
        lines.push(`    ${prop}: ${value};`)
      }
      lines.push('  }')
    }
    lines.push('')
  }

  if (inheritedRules.length > 0) {
    const byAncestor = new Map<string, StyleRule[]>()
    for (const rule of inheritedRules) {
      const key = rule.inheritedFrom!
      if (!byAncestor.has(key)) {
        byAncestor.set(key, [])
      }
      byAncestor.get(key)!.push(rule)
    }

    for (const [ancestor, rules] of byAncestor) {
      lines.push(`Inherited from ${ancestor}:`)
      for (const rule of rules) {
        lines.push(`  ${rule.selector} {`)
        const sourceInfo = rule.source ? ` /* ${rule.source.url}:${rule.source.line}:${rule.source.column} */` : ''
        if (sourceInfo) {
          lines.push(`   ${sourceInfo}`)
        }
        for (const [prop, value] of Object.entries(rule.declarations)) {
          lines.push(`    ${prop}: ${value};`)
        }
        lines.push('  }')
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}
