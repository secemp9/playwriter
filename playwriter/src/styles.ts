import type { ICDPSession } from './cdp-session.js'
import type { Locator } from '@xmorse/playwright-core'
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

interface CSSRule {
  selectorList: { text: string }
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
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')

  const elementHandle = await locator.elementHandle()
  if (!elementHandle) {
    throw new Error('Could not get element handle from locator')
  }

  const remoteObject = (elementHandle as any)._channel?.objectId
    ? { objectId: (elementHandle as any)._channel.objectId }
    : null

  let backendNodeId: number
  if (remoteObject?.objectId) {
    const nodeInfo = await cdp.send('DOM.describeNode', {
      objectId: remoteObject.objectId,
    })
    backendNodeId = nodeInfo.node.backendNodeId
  } else {
    const box = await elementHandle.boundingBox()
    if (!box) {
      throw new Error('Element has no bounding box')
    }
    const docResult = await cdp.send('DOM.getDocument', { depth: 0 })
    const nodeAtPoint = await cdp.send('DOM.getNodeForLocation', {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    })
    backendNodeId = nodeAtPoint.backendNodeId
  }

  const pushResult = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: [backendNodeId],
  })
  const nodeId = pushResult.nodeIds[0]

  if (!nodeId) {
    throw new Error('Could not get nodeId for element')
  }

  const nodeInfo = await cdp.send('DOM.describeNode', { nodeId })
  const elementDescription = formatElementDescription(nodeInfo.node)

  const matchedStyles = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })

  const stylesheetUrls = new Map<string, string>()

  const processStyleSheetId = async (styleSheetId: string | undefined): Promise<StyleSource | null> => {
    if (!styleSheetId) {
      return null
    }

    if (!stylesheetUrls.has(styleSheetId)) {
      try {
        const header = await cdp.send('CSS.getStyleSheetText', { styleSheetId })
        stylesheetUrls.set(styleSheetId, '')
      } catch {
        stylesheetUrls.set(styleSheetId, '')
      }
    }

    return null
  }

  const rules: StyleRule[] = []

  if (matchedStyles.matchedCSSRules) {
    for (const ruleMatch of matchedStyles.matchedCSSRules) {
      const rule = ruleMatch.rule
      const sourceRange = (rule as any).selectorList?.range as SourceRange | undefined
      const styleSheetId = rule.styleSheetId

      let source: StyleSource | null = null
      if (styleSheetId && sourceRange) {
        const styleSheet = (matchedStyles as any).cssStyleSheetHeaders?.find(
          (h: CSSStyleSheetHeader) => h.styleSheetId === styleSheetId,
        )
        const url =
          styleSheet?.sourceURL || (rule as any).origin === 'user-agent' ? 'user-agent' : `stylesheet:${styleSheetId}`

        source = {
          url: (rule as any).styleSheetId ? await getStylesheetUrl(cdp, styleSheetId) : 'user-agent',
          line: sourceRange.startLine + 1,
          column: sourceRange.startColumn,
        }
      }

      rules.push({
        selector: rule.selectorList.text,
        source,
        origin: rule.origin as StyleRule['origin'],
        declarations: extractDeclarations(rule.style),
        inheritedFrom: null,
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
        const sourceRange = (rule as any).selectorList?.range as SourceRange | undefined
        const styleSheetId = rule.styleSheetId

        let source: StyleSource | null = null
        if (styleSheetId && sourceRange) {
          source = {
            url: await getStylesheetUrl(cdp, styleSheetId),
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

  const urlFor = (styleSheetId: string | undefined, origin: string): string => {
    if (origin === 'user-agent') return 'user-agent'
    if (!styleSheetId) return ''
    const header = headers.find((h) => h.styleSheetId === styleSheetId)
    return header?.sourceURL || `stylesheet:${styleSheetId}`
  }

  let order = 0

  if (matchedStyles?.matchedCSSRules) {
    for (const ruleMatch of matchedStyles.matchedCSSRules as RuleMatch[]) {
      const rule = ruleMatch.rule
      const { declarations, important } = splitDeclarations(rule.style)
      if (Object.keys(declarations).length === 0) {
        continue
      }

      const sourceRange = (rule as any).selectorList?.range as SourceRange | undefined
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
      })
    }
  }

  if (matchedStyles?.inlineStyle) {
    const { declarations, important } = splitDeclarations(matchedStyles.inlineStyle as CSSStyle)
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
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  // CDP rejects `DOM.pushNodesByBackendIdsToFrontend` with "Document needs to be
  // requested first" unless the document has been fetched on THIS session. On a
  // fresh session nothing else has done it yet, so do it here.
  await cdp.send('DOM.getDocument', { depth: 0 })

  const elementHandle = await locator.elementHandle()
  if (!elementHandle) {
    throw new Error('Could not get element handle from locator')
  }

  const objectId = (elementHandle as any)._channel?.objectId as string | undefined
  let backendNodeId: number
  if (objectId) {
    const nodeInfo = await cdp.send('DOM.describeNode', { objectId })
    backendNodeId = nodeInfo.node.backendNodeId
  } else {
    const box = await elementHandle.boundingBox()
    if (!box) {
      throw new Error('Element has no bounding box')
    }
    const nodeAtPoint = await cdp.send('DOM.getNodeForLocation', {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    })
    backendNodeId = nodeAtPoint.backendNodeId
  }

  const pushResult = await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: [backendNodeId],
  })
  const nodeId = pushResult.nodeIds[0]
  if (!nodeId) {
    throw new Error('Could not get nodeId for element')
  }

  const matchedStyles = await cdp.send('CSS.getMatchedStylesForNode', { nodeId })
  return { backendNodeId, nodeId, rules: normalizeMatchedStyles(matchedStyles), matchedStyles }
}

/** Like `extractDeclarations` but keeps clean values + a separate `!important` set. */
function splitDeclarations(style: CSSStyle): { declarations: StyleDeclarations; important: Set<string> } {
  const declarations: StyleDeclarations = {}
  const important = new Set<string>()
  if (!style?.cssProperties) {
    return { declarations, important }
  }
  for (const prop of style.cssProperties) {
    if (!prop.value || prop.value === 'initial' || prop.name.startsWith('-webkit-')) {
      continue
    }
    declarations[prop.name] = prop.value
    if (prop.important) {
      important.add(prop.name)
    }
  }
  return { declarations, important }
}

/** Specificity of a matched rule, taking the MAX over just its matched selectors. */
function specificityForRule(rule: CSSRule, matchingSelectors?: number[]): Specificity {
  const selectors = (rule as any).selectorList?.selectors as Array<{ text: string }> | undefined
  if (Array.isArray(selectors) && Array.isArray(matchingSelectors) && matchingSelectors.length > 0) {
    let best: Specificity = [0, 0, 0]
    for (const idx of matchingSelectors) {
      const text = selectors[idx]?.text
      if (typeof text === 'string') {
        const spec = computeSpecificity(text)
        if (compareSpecificity(spec, best) > 0) {
          best = spec
        }
      }
    }
    return best
  }
  return computeSpecificity(rule.selectorList?.text ?? '')
}

function extractDeclarations(style: CSSStyle): StyleDeclarations {
  if (!style?.cssProperties) {
    return {}
  }

  const result: StyleDeclarations = {}
  for (const prop of style.cssProperties) {
    if (!prop.value || prop.value === 'initial' || prop.name.startsWith('-webkit-')) {
      continue
    }
    const value = prop.important ? `${prop.value} !important` : prop.value
    result[prop.name] = value
  }
  return result
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

async function getStylesheetUrl(cdp: ICDPSession, styleSheetId: string): Promise<string> {
  try {
    await cdp.send('CSS.getStyleSheetText', { styleSheetId })
    return `stylesheet:${styleSheetId}`
  } catch {
    return `stylesheet:${styleSheetId}`
  }
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
