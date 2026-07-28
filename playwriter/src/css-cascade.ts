/**
 * css-cascade.ts — Milestone 2: CSS cascade-winner provenance.
 *
 * A pure module (no CDP, no browser) that takes already-fetched matched-styles
 * data and computes the CSS cascade: for every declared property it determines
 * the winning declaration and the ordered list of losers, applying real cascade
 * order (origin/importance tier → specificity → source order).
 *
 * `computeSpecificity` uses css-tree to parse a selector list and count
 * (#id, .class/[attr]/:pseudo-class, type/::pseudo-element), taking the MAX over
 * the comma-separated selector list.
 */

import * as csstree from 'css-tree'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** [a, b, c] = (#id, .class/[attr]/:pseudo-class, type/::pseudo-element). */
export type Specificity = [number, number, number]

export interface StyleSourceRef {
  url: string
  line: number
  column: number
}

/**
 * A rule normalized into the shape `resolveCascade` consumes. `origin` is the
 * raw CDP origin ('regular' | 'user-agent' | 'injected' | 'inspector'); `inline`
 * marks style-attribute declarations. `order` is the CDP application order
 * (higher = later = wins the source-order tiebreak). `important` holds the set
 * of property names carrying `!important` in this rule.
 */
export interface NormalizedRule {
  selector: string
  specificity: Specificity
  declarations: Record<string, string>
  important: Set<string>
  origin: string
  source: StyleSourceRef | null
  inline?: boolean
  order: number
  /** CDP stylesheet id, when known — lets callers fetch source text for code-frames. */
  styleSheetId?: string
}

/** A cycle-free reference to a single declaration (winner or loser). */
export interface DeclRef {
  selector: string
  value: string
  important: boolean
  source: StyleSourceRef | null
  origin: string
}

export interface CascadeResult {
  winnerFor: Record<string, DeclRef>
  losersFor: Record<string, DeclRef[]>
}

// ---------------------------------------------------------------------------
// Specificity
// ---------------------------------------------------------------------------

// Legacy pseudo-elements written with a single colon. css-tree parses these as
// PseudoClassSelector, but per spec they count toward the pseudo-element (c) tier.
const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter'])

// Functional pseudo-classes whose specificity is that of their argument.
const ARG_SPECIFICITY_PSEUDOS = new Set(['not', 'is', 'has'])

function addSpec(a: Specificity, b: Specificity): Specificity {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/** Lexicographic compare: >0 if x is more specific than y, <0 if less, 0 equal. */
export function compareSpecificity(x: Specificity, y: Specificity): number {
  if (x[0] !== y[0]) return x[0] - y[0]
  if (x[1] !== y[1]) return x[1] - y[1]
  return x[2] - y[2]
}

function maxSpec(a: Specificity, b: Specificity): Specificity {
  return compareSpecificity(a, b) >= 0 ? a : b
}

/** Specificity of a single css-tree `Selector` node (a complex selector). */
function specificityOfSelectorNode(selector: csstree.CssNode): Specificity {
  let spec: Specificity = [0, 0, 0]
  const children = (selector as any).children as csstree.List<csstree.CssNode> | undefined
  if (!children) return spec

  children.forEach((node: csstree.CssNode) => {
    switch (node.type) {
      case 'IdSelector':
        spec = addSpec(spec, [1, 0, 0])
        break
      case 'ClassSelector':
      case 'AttributeSelector':
        spec = addSpec(spec, [0, 1, 0])
        break
      case 'TypeSelector': {
        // `*` (universal) contributes nothing.
        if ((node as csstree.TypeSelector).name !== '*') {
          spec = addSpec(spec, [0, 0, 1])
        }
        break
      }
      case 'PseudoElementSelector':
        spec = addSpec(spec, [0, 0, 1])
        break
      case 'PseudoClassSelector': {
        const name = (node as csstree.PseudoClassSelector).name.toLowerCase()
        if (LEGACY_PSEUDO_ELEMENTS.has(name)) {
          spec = addSpec(spec, [0, 0, 1])
        } else if (name === 'where') {
          // :where() always contributes zero specificity.
        } else if (ARG_SPECIFICITY_PSEUDOS.has(name)) {
          spec = addSpec(spec, specificityOfPseudoArgument(node))
        } else {
          spec = addSpec(spec, [0, 1, 0])
        }
        break
      }
      // NestingSelector (&), Combinator, WhiteSpace, Raw → contribute nothing.
      default:
        break
    }
  })

  return spec
}

/** Max specificity over the SelectorList nested inside :not()/:is()/:has(). */
function specificityOfPseudoArgument(pseudo: csstree.CssNode): Specificity {
  let best: Specificity = [0, 0, 0]
  const children = (pseudo as any).children as csstree.List<csstree.CssNode> | undefined
  if (!children) return best
  children.forEach((child: csstree.CssNode) => {
    if (child.type === 'SelectorList') {
      const innerChildren = (child as any).children as csstree.List<csstree.CssNode>
      innerChildren.forEach((sel: csstree.CssNode) => {
        if (sel.type === 'Selector') {
          best = maxSpec(best, specificityOfSelectorNode(sel))
        }
      })
    } else if (child.type === 'Selector') {
      best = maxSpec(best, specificityOfSelectorNode(child))
    }
  })
  return best
}

/**
 * Compute the specificity of a selector string. For a comma-separated list the
 * MAX specificity over all selectors is returned. Parse failures yield [0,0,0].
 */
export function computeSpecificity(selector: string): Specificity {
  let ast: csstree.CssNode
  try {
    ast = csstree.parse(selector, { context: 'selectorList' })
  } catch {
    return [0, 0, 0]
  }

  let best: Specificity = [0, 0, 0]
  const children = (ast as any).children as csstree.List<csstree.CssNode> | undefined
  if (!children) return best
  children.forEach((sel: csstree.CssNode) => {
    if (sel.type === 'Selector') {
      best = maxSpec(best, specificityOfSelectorNode(sel))
    }
  })
  return best
}

// ---------------------------------------------------------------------------
// Cascade resolution
// ---------------------------------------------------------------------------

/**
 * Cascade-order tier (higher wins), following the standard origin/importance
 * order:
 *   (6) important user-agent   — rare, tops everything
 *   (5) inline important       — author inline !important, beats author-selector important
 *   (4) important author       — author-selector !important
 *   (3) inline normal          — author inline (also wins via [1,0,0,0]-tier specificity)
 *   (2) author normal
 *   (1) user-agent normal
 * Within a tier, specificity breaks ties, then source order (later wins).
 */
function tierOf(rule: NormalizedRule, important: boolean): number {
  const isUA = rule.origin === 'user-agent'
  const isInline = rule.inline === true
  if (important) {
    if (isUA) return 6
    if (isInline) return 5
    return 4
  }
  if (isInline) return 3
  if (isUA) return 1
  return 2
}

interface CascadeEntry {
  ref: DeclRef
  tier: number
  spec: Specificity
  order: number
}

/**
 * Resolve the cascade for a set of normalized rules. For every declared
 * property, returns the winning `DeclRef` plus the ordered losers (highest to
 * lowest priority among the non-winners).
 */
export function resolveCascade(rules: NormalizedRule[]): CascadeResult {
  const byProp = new Map<string, CascadeEntry[]>()

  for (const rule of rules) {
    for (const [prop, value] of Object.entries(rule.declarations)) {
      const important = rule.important.has(prop)
      const ref: DeclRef = {
        selector: rule.selector,
        value,
        important,
        source: rule.source,
        origin: rule.origin,
      }
      const entry: CascadeEntry = {
        ref,
        tier: tierOf(rule, important),
        spec: rule.specificity,
        order: rule.order,
      }
      const list = byProp.get(prop)
      if (list) {
        list.push(entry)
      } else {
        byProp.set(prop, [entry])
      }
    }
  }

  const winnerFor: Record<string, DeclRef> = {}
  const losersFor: Record<string, DeclRef[]> = {}

  for (const [prop, list] of byProp) {
    // Stable-sort descending so index 0 is the cascade winner.
    list.sort((a, b) => {
      if (a.tier !== b.tier) return b.tier - a.tier
      const s = compareSpecificity(b.spec, a.spec)
      if (s !== 0) return s
      return b.order - a.order
    })
    winnerFor[prop] = list[0].ref
    losersFor[prop] = list.slice(1).map((e) => e.ref)
  }

  return { winnerFor, losersFor }
}

// ---------------------------------------------------------------------------
// Rendering (pure text)
// ---------------------------------------------------------------------------

function formatSourceComment(source: StyleSourceRef | null): string {
  if (!source) return ''
  return ` /* ${source.url}:${source.line}:${source.column} */`
}

function formatDeclLine(prefix: string, ref: DeclRef, prop: string): string {
  const bang = ref.important ? ' !important' : ''
  return `  ${prefix} ${ref.selector} { ${prop}: ${ref.value}${bang} }${formatSourceComment(ref.source)}`
}

/**
 * Render a cascade result as a compact, human-readable report. The winning
 * declaration is marked with `>`, losers with `x`, highest to lowest priority.
 * Pure — no CDP / code-frame (that enrichment happens in the executor).
 */
export function formatCascadeReport(opts: {
  element?: string
  winnerFor: Record<string, DeclRef>
  losersFor: Record<string, DeclRef[]>
  properties?: string[]
}): string {
  const lines: string[] = []
  if (opts.element) {
    lines.push(`Element: ${opts.element}`)
    lines.push('')
  }
  const props = opts.properties ?? Object.keys(opts.winnerFor)
  for (const prop of props) {
    const winner = opts.winnerFor[prop]
    if (!winner) continue
    lines.push(`${prop}:`)
    lines.push(formatDeclLine('>', winner, prop))
    for (const loser of opts.losersFor[prop] ?? []) {
      lines.push(formatDeclLine('x', loser, prop))
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
