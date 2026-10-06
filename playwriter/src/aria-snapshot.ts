// Accessibility snapshot pipeline: build raw AX tree, filter to a
// tree (interactive-only, labels/contexts, wrapper hoisting, ignored
// indent preservation), then render lines and locators.
import type { Page, Locator, ElementHandle, Frame, FrameLocator } from '@xmorse/playwright-core'
import fs from 'node:fs'
import type { Protocol } from 'devtools-protocol'
import type { ICDPSession } from './cdp-session.js'
import { getCDPSessionForPage, getCDPSessionForFrame } from './cdp-session.js'
import { axStatesFromNode, formatAxStates, type AxStates } from './ax-states.js'
import { resolveElement, type ElementTarget } from './element-resolve.js'
import { withDeadline } from './isolated-world.js'

// Import sharp at module level - resolves to null if not available
const sharpPromise = import('sharp')
  .then((m) => {
    return m.default
  })
  .catch(() => {
    return null
  })

// ============================================================================
// Snapshot Format Types
// ============================================================================

export type SnapshotFormat = 'raw'

export const DEFAULT_SNAPSHOT_FORMAT: SnapshotFormat = 'raw'

/**
 * Deadline for each CDP read in `getAriaSnapshot`. The whole-document reads
 * (`DOM.getFlattenedDocument`, `Accessibility.getFullAXTree`) take seconds on a page with tens of
 * thousands of nodes; anything approaching this is a wedged target, not a slow one.
 */
const SNAPSHOT_CDP_TIMEOUT_MS = 30000

// ============================================================================
// Types
// ============================================================================

export interface AriaRef {
  role: string
  name: string
  ref: string
  shortRef: string
  backendNodeId?: Protocol.DOM.BackendNodeId
}

type AriaRefDraft = Omit<AriaRef, 'shortRef'> & { selector?: string }

export type AriaSnapshotNode = {
  role: string
  name: string
  locator?: string
  ref?: string
  shortRef?: string
  backendNodeId?: Protocol.DOM.BackendNodeId
  /** AX states (checked, disabled, expanded, focused…). Absent when Chromium reported none. */
  states?: AxStates
  /**
   * The AX value of a field (textbox/searchbox/combobox/spinbutton/slider), absent when
   * empty. An `<input type=password>` with a value reads `'••••'` — never the secret.
   */
  value?: string
  /**
   * The node's own accessible name, present only when `name` was blanked because a
   * descendant already prints the same text (a link wrapping `<img alt="Home">` has
   * `name: ''` and `axName: 'Home'`). Consumers that list controls without their
   * descendants need it, or the link would be nameless.
   */
  axName?: string
  /**
   * The role of the control whose accessible name this node's text is: the node is (inside) a
   * `<label>` or `aria-labelledby` target Chromium read that control's name from. The control's
   * own line already says it, so a reader of the page's text can tell it apart from prose.
   */
  labels?: string
  children: AriaSnapshotNode[]
}

// ============================================================================
// Image Resize Utility
// ============================================================================

/**
 * LLM-optimal max dimension. Claude auto-resizes images larger than 1568px
 * on any edge, adding latency. Token cost: (width * height) / 750.
 */
export const LLM_MAX_DIMENSION = 1568

export interface ResizeImageOptions {
  /** Input: file path or Buffer */
  input: string | Buffer
  /** Max pixels on longest edge. Default 1568 (Claude-optimal).
   *  Ignored if explicit width/height provided. */
  maxDimension?: number
  /** Explicit target width in px (aspect ratio preserved unless both width+height set) */
  width?: number
  /** Explicit target height in px */
  height?: number
  /** How to fit when both width+height specified. Default 'inside' (preserve aspect ratio, no crop) */
  fit?: 'inside' | 'cover' | 'contain' | 'fill'
  /** JPEG quality 1-100. Default 80 */
  quality?: number
  /** Output format. Default 'jpeg'. Use 'png' for lossless output (e.g. Kitty Graphics). */
  format?: 'jpeg' | 'png'
  /** Output file path. Defaults to overwriting the input file (when input is a path) */
  output?: string
}

export interface ResizeImageResult {
  buffer: Buffer
  mimeType: 'image/png' | 'image/jpeg'
  /** Only set if output path was provided */
  path?: string
}

/**
 * Resize an image using sharp. Useful for shrinking screenshots before reading
 * them back into context so they consume fewer tokens.
 *
 * Default behavior (no width/height): fits within 1568×1568px, preserving
 * aspect ratio, never upscales. This is optimal for Claude vision.
 *
 * Explicit width/height: resizes to those dimensions using the fit strategy.
 */
export async function resizeImageForAgent(options: ResizeImageOptions): Promise<ResizeImageResult> {
  const sharp = await sharpPromise
  if (!sharp) {
    throw new Error('sharp is not installed — install it with: pnpm add sharp')
  }

  const inputBuffer = (() => {
    if (Buffer.isBuffer(options.input)) {
      return options.input
    }
    return fs.readFileSync(options.input)
  })()

  const quality = options.quality ?? 80
  const hasExplicitDimensions = options.width !== undefined || options.height !== undefined

  const fit = options.fit ?? 'inside'
  const resizeOpts = (() => {
    if (hasExplicitDimensions) {
      return {
        width: options.width,
        height: options.height,
        fit,
        withoutEnlargement: false,
      }
    }
    const max = options.maxDimension ?? LLM_MAX_DIMENSION
    return {
      width: max,
      height: max,
      fit,
      withoutEnlargement: true,
    }
  })()

  const fmt = options.format ?? 'png'
  const pipeline = sharp(inputBuffer).resize(resizeOpts)
  const buffer = await (fmt === 'png' ? pipeline.png() : pipeline.jpeg({ quality })).toBuffer()

  // Default: overwrite input file. When input is a Buffer, no file is written
  // unless output is explicitly set.
  const outputPath = (() => {
    if (options.output) {
      return options.output
    }
    if (typeof options.input === 'string') {
      return options.input
    }
    return undefined
  })()

  if (outputPath) {
    fs.writeFileSync(outputPath, buffer)
  }

  const mimeType: 'image/png' | 'image/jpeg' = fmt === 'png' ? 'image/png' : 'image/jpeg'
  return {
    buffer,
    mimeType,
    ...(outputPath ? { path: outputPath } : {}),
  }
}

export interface AriaSnapshotResult {
  snapshot: string
  tree: AriaSnapshotNode[]
  refs: AriaRef[]
  refToElement: Map<string, { role: string; name: string; shortRef: string }>
  refToSelector: Map<string, string>
  /**
   * Get a CSS selector for a ref. Use with page.locator().
   * For stable test IDs, returns [data-testid="..."] or [id="..."]
   * For fallback refs, returns a role-based selector.
   */
  getSelectorForRef: (ref: string) => string | null
  getRefsForLocators: (locators: Array<Locator | ElementHandle>) => Promise<Array<AriaRef | null>>
  getRefForLocator: (locator: Locator | ElementHandle) => Promise<AriaRef | null>
  getRefStringForLocator: (locator: Locator | ElementHandle) => Promise<string | null>
}

export function buildShortRefMap({ refs }: { refs: Array<{ ref: string }> }): Map<string, string> {
  const map = new Map<string, string>()
  refs.forEach((entry, index) => {
    map.set(entry.ref, `e${index + 1}`)
  })
  return map
}

// Roles that represent interactive elements
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'searchbox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  'img',
  'video',
  'audio',
])

const LABEL_ROLES = new Set(['labeltext'])

const CONTEXT_ROLES = new Set([
  'navigation',
  'main',
  'contentinfo',
  'banner',
  'form',
  'section',
  'region',
  'list',
  'listitem',
  'table',
  'rowgroup',
  'row',
  'cell',
])

const SKIP_WRAPPER_ROLES = new Set(['generic', 'group', 'none', 'presentation'])

const TEST_ID_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-pw',
  'data-qa',
  'data-e2e',
  'data-automation-id',
]

type DomNodeInfo = {
  nodeId: Protocol.DOM.NodeId
  parentId?: Protocol.DOM.NodeId
  backendNodeId: Protocol.DOM.BackendNodeId
  nodeName: string
  attributes: Map<string, string>
}

function toAttributeMap(attributes?: string[]): Map<string, string> {
  const result = new Map<string, string>()
  if (!attributes) {
    return result
  }
  for (let i = 0; i < attributes.length; i += 2) {
    const name = attributes[i]
    const value = attributes[i + 1]
    if (name) {
      result.set(name, value ?? '')
    }
  }
  return result
}

function getStableRefFromAttributes(attributes: Map<string, string>): { value: string; attr: string } | null {
  // Test IDs first: they are explicitly placed by developers for automation
  // and more stable than id which is often auto-generated by frameworks
  for (const attr of TEST_ID_ATTRS) {
    const value = attributes.get(attr)
    if (value) {
      return { value, attr }
    }
  }
  const id = attributes.get('id')
  if (id) {
    return { value: id, attr: 'id' }
  }
  return null
}

function escapeLocatorValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function buildLocatorFromStable(stable: { value: string; attr: string }): string {
  const escaped = escapeLocatorValue(stable.value)
  return `[${stable.attr}="${escaped}"]`
}

function buildBaseLocator({
  role,
  name,
  stable,
  isPromotedContentEditable,
}: {
  role: string
  name: string
  stable: { value: string; attr: string } | null
  isPromotedContentEditable?: boolean
}): string {
  if (stable) {
    return buildLocatorFromStable(stable)
  }
  // For promoted contenteditable elements (bare <div contenteditable="true"> without
  // role="textbox"), use CSS attribute selector. Playwright's role=textbox selector
  // won't match these because Chrome doesn't assign an implicit textbox role to
  // contenteditable divs. Elements that already had role="textbox" use the normal
  // role-based locator since Playwright matches those correctly.
  //
  // MEASURED against Chromium 145.0.7632.18 on a page holding
  // `<div contenteditable=true>`, `<div contenteditable=true role=textbox>` and
  // `<textarea>`. Chrome's own AX roles:
  //
  //     bare contenteditable div          role "generic"   (ignored: false)
  //     contenteditable div + role=textbox role "textbox"
  //     textarea                           role "textbox"
  //
  // and Playwright's `role=textbox` selector matches 2 of the 3 — the roled div and the
  // textarea — and 0 for the bare one. So both halves of the paragraph above hold: Chrome
  // really does report "generic", and Playwright really does not match it.
  //
  // KNOWN WEAKNESS of the replacement, not fixed here: `[contenteditable="true"]` is not
  // unique. The same measurement had it match 2 elements on that page. `finalizeSnapshotOutput`
  // disambiguates repeated base locators with `>> nth=`, but `getSelectorForRef` returns
  // this string unqualified, so a ref for the second editor on a page resolves to the first.
  if (isPromotedContentEditable) {
    return `[contenteditable="true"]`
  }
  const trimmedName = name.trim()
  if (trimmedName.length > 0) {
    const escapedName = escapeLocatorValue(trimmedName)
    return `role=${role}[name="${escapedName}"]`
  }
  return `role=${role}`
}

function getAxValueString(value?: Protocol.Accessibility.AXValue): string {
  if (!value) {
    return ''
  }
  const raw = value.value
  if (typeof raw === 'string') {
    return raw
  }
  if (raw === undefined || raw === null) {
    return ''
  }
  return String(raw)
}

function getAxRole(node: Protocol.Accessibility.AXNode): string {
  const role = getAxValueString(node.role)
  return role.toLowerCase()
}

export type SnapshotLine = {
  text: string
  baseLocator?: string
  hasChildren?: boolean
  role?: string
  name?: string
  indent?: number
  /** State tokens and value (` [checked] = "a@b.c"`), re-appended when the line is rebuilt around its locator. */
  suffix?: string
}

export type SnapshotNode = {
  role: string
  name: string
  baseLocator?: string
  ref?: string
  backendNodeId?: Protocol.DOM.BackendNodeId
  indentOffset?: number
  ignored?: boolean
  states?: AxStates
  value?: string
  axName?: string
  labels?: string
  children: SnapshotNode[]
}

/**
 * The DOM nodes that gave a control its accessible name, mapped to the control's role: a
 * `<label for>` or wrapping `<label>`, an `aria-labelledby` target. Chromium reports where each
 * name came from: the winning `name.sources` entry (it holds the value and is not superseded)
 * lists the nodes it read in `relatedNodes`.
 */
export function controlNameSources(axById: Map<Protocol.Accessibility.AXNodeId, Protocol.Accessibility.AXNode>): Map<Protocol.DOM.BackendNodeId, string> {
  const sources = new Map<Protocol.DOM.BackendNodeId, string>()
  for (const node of axById.values()) {
    if (node.ignored) continue
    const role = getAxRole(node)
    if (!INTERACTIVE_ROLES.has(role)) continue
    const winner = node.name?.sources?.find((source) => source.value !== undefined && !source.superseded && !source.invalid)
    if (winner?.type !== 'relatedElement') continue
    for (const related of winner.nativeSourceValue?.relatedNodes ?? winner.attributeValue?.relatedNodes ?? []) {
      sources.set(related.backendDOMNodeId, role)
    }
  }
  return sources
}

/**
 * Roles whose AX `value` is what the user typed or picked. Other roles report values
 * too (a link's `url`, a heading's nothing), but those are not field contents. The
 * date/time/colour roles are Chromium's for native date, datetime-local/month/week, time
 * and colour inputs (`ax_node_object.cc`); their value is the field's ISO / `#rrggbb` value.
 */
const VALUE_ROLES: Record<string, true> = {
  textbox: true,
  searchbox: true,
  combobox: true,
  spinbutton: true,
  slider: true,
  date: true,
  datetime: true,
  inputtime: true,
  colorwell: true,
}

/**
 * `autocomplete` tokens that name a secret (HTML autofill field names): what the browser
 * fills there is a password, a one-time code or card security data.
 */
const SECRET_AUTOCOMPLETE_TOKENS: Record<string, true> = {
  'current-password': true,
  'new-password': true,
  'one-time-code': true,
  'cc-csc': true,
  'cc-number': true,
}

/**
 * Whether a field's value is a secret by what the author declared in the DOM: `type=password`,
 * or an `autocomplete` token naming a password, one-time code or card number/security code.
 * Fields that draw bullets through CSS (`-webkit-text-security`) are a computed-style fact
 * this DOM row does not carry; observe() reads that style in the isolated world.
 */
export function isSecretField(nodeName: string, type: string | undefined, autocomplete: string | undefined): boolean {
  const tag = nodeName.toLowerCase()
  if (tag !== 'input' && tag !== 'textarea') return false
  if (tag === 'input' && type?.toLowerCase() === 'password') return true
  return (autocomplete ?? '').toLowerCase().split(/\s+/).some((token) => SECRET_AUTOCOMPLETE_TOKENS[token] === true)
}

/**
 * What `snapshot()` lines and the tree carry about a node's state: its AX states and
 * its field value, with a secret field's value replaced by `'••••'`.
 *
 * Masked from the DOM, not from the AX value: Chromium 145 already reports a password
 * field's AX value as bullets (measured: `"••••••"` for "secret"), but the bullet count
 * leaks the length and nothing guarantees every Chrome build masks, whereas `type=password`
 * and a secret `autocomplete` token are the author's own statement that the value is a
 * secret. A value whose DOM row is missing cannot be checked, so it is masked.
 */
function stateFields(
  node: SnapshotNode,
  domByBackendId: Map<Protocol.DOM.BackendNodeId, DomNodeInfo>,
): Pick<SnapshotNode, 'states' | 'value'> {
  let value = node.value
  if (value !== undefined) {
    const domInfo = node.backendNodeId !== undefined ? domByBackendId.get(node.backendNodeId) : undefined
    if (!domInfo || isSecretField(domInfo.nodeName, domInfo.attributes.get('type'), domInfo.attributes.get('autocomplete'))) value = '••••'
  }
  return {
    ...(node.states ? { states: node.states } : {}),
    ...(value !== undefined ? { value } : {}),
  }
}

function buildSnapshotLine({
  role,
  name,
  baseLocator,
  indent,
  hasChildren,
  suffix,
}: {
  role: string
  name: string
  baseLocator?: string
  indent: number
  hasChildren: boolean
  suffix: string
}): SnapshotLine {
  const prefix = '  '.repeat(indent)
  let text = `${prefix}- ${role}`
  if (name) {
    const escapedName = name.replace(/"/g, '\\"')
    text += ` "${escapedName}"`
  }
  text += suffix
  return { text, baseLocator, hasChildren, role, name, indent, ...(suffix ? { suffix } : {}) }
}

function buildTextLine(text: string, indent: number): SnapshotLine {
  const prefix = '  '.repeat(indent)
  const escaped = text.replace(/"/g, '\\"')
  return { text: `${prefix}- text: "${escaped}"` }
}

export function buildSnapshotLines(nodes: SnapshotNode[], indent = 0): SnapshotLine[] {
  return nodes.flatMap((node) => {
    const nodeIndent = indent + (node.indentOffset ?? 0)
    // A contenteditable's AX value is its whole text, newlines included (measured on a
    // `plaintext-only` editor). One snapshot line per node is the format's contract, so
    // the value is flattened and capped here; the tree keeps it whole.
    const flatValue = (node.value ?? '').replace(/\s+/g, ' ').trim()
    const shownValue = flatValue.length > 100 ? `${flatValue.slice(0, 99)}…` : flatValue
    const line =
      node.role === 'text'
        ? buildTextLine(node.name, nodeIndent)
        : buildSnapshotLine({
            role: node.role,
            name: node.name,
            baseLocator: node.baseLocator,
            indent: nodeIndent,
            hasChildren: node.children.length > 0,
            suffix: formatAxStates(node.states, node.role) + (shownValue ? ` = "${shownValue.replace(/"/g, '\\"')}"` : ''),
          })
    return [line, ...buildSnapshotLines(node.children, nodeIndent + 1)]
  })
}

function shiftIndent(nodes: SnapshotNode[], offset: number): SnapshotNode[] {
  return nodes.map((node) => {
    return { ...node, indentOffset: (node.indentOffset ?? 0) + offset }
  })
}

export function buildRawSnapshotTree(options: {
  nodeId: Protocol.Accessibility.AXNodeId
  axById: Map<Protocol.Accessibility.AXNodeId, Protocol.Accessibility.AXNode>
  isNodeInScope: (node: Protocol.Accessibility.AXNode) => boolean
  /** `controlNameSources(axById)`. */
  nameSources: Map<Protocol.DOM.BackendNodeId, string>
  /** The role of the control an enclosing label names (inherited down the label's subtree). */
  labels?: string
}): SnapshotNode | null {
  const node = options.axById.get(options.nodeId)
  if (!node) {
    return null
  }

  const role = getAxRole(node)
  const name = getAxValueString(node.name).trim()
  const labels = (node.backendDOMNodeId !== undefined ? options.nameSources.get(node.backendDOMNodeId) : undefined) ?? options.labels
  const children = (node.childIds ?? [])
    .map((childId) => {
      return buildRawSnapshotTree({
        nodeId: childId,
        axById: options.axById,
        isNodeInScope: options.isNodeInScope,
        nameSources: options.nameSources,
        ...(labels !== undefined ? { labels } : {}),
      })
    })
    .filter(isTruthy)

  const inScope = options.isNodeInScope(node) || children.length > 0
  if (!inScope) {
    return null
  }

  const states = axStatesFromNode(node)
  const value = VALUE_ROLES[role] ? getAxValueString(node.value) : ''
  return {
    role,
    name,
    backendNodeId: node.backendDOMNodeId,
    ignored: node.ignored,
    ...(states ? { states } : {}),
    ...(value !== '' ? { value } : {}),
    ...(labels !== undefined ? { labels } : {}),
    children,
  }
}

export function filterInteractiveSnapshotTree(options: {
  node: SnapshotNode
  ancestorNames: string[]
  labelContext: boolean
  refFilter?: (entry: { role: string; name: string }) => boolean
  domByBackendId: Map<Protocol.DOM.BackendNodeId, DomNodeInfo>
  promotedContentEditableIds?: Set<Protocol.DOM.BackendNodeId>
  createRefForNode: (options: {
    backendNodeId?: Protocol.DOM.BackendNodeId
    role: string
    name: string
  }) => string | null
}): { nodes: SnapshotNode[]; names: Set<string> } {
  const role = options.node.role
  const name = options.node.name
  const hasName = name.length > 0
  const nextAncestors = hasName ? [...options.ancestorNames, name] : options.ancestorNames

  const isLabel = LABEL_ROLES.has(role)
  const nextLabelContext = options.labelContext || isLabel

  const childResults = options.node.children.map((child) => {
    return filterInteractiveSnapshotTree({
      node: child,
      ancestorNames: nextAncestors,
      labelContext: nextLabelContext,
      refFilter: options.refFilter,
      domByBackendId: options.domByBackendId,
      promotedContentEditableIds: options.promotedContentEditableIds,
      createRefForNode: options.createRefForNode,
    })
  })
  const childNodes = childResults.flatMap((result) => {
    return result.nodes
  })
  const childNames = childResults.reduce((acc, result) => {
    result.names.forEach((childName) => {
      acc.add(childName)
    })
    return acc
  }, new Set<string>())

  if (options.node.ignored) {
    return { nodes: shiftIndent(childNodes, 1), names: childNames }
  }

  if (isTextRole(role)) {
    if (!hasName) {
      return { nodes: childNodes, names: childNames }
    }
    if (!options.labelContext) {
      return { nodes: childNodes, names: childNames }
    }
    const isRedundantText = options.ancestorNames.some((ancestor) => {
      return ancestor.includes(name) || name.includes(ancestor)
    })
    if (isRedundantText) {
      return { nodes: childNodes, names: childNames }
    }
    const names = new Set(childNames)
    names.add(name)
    // The DOM text node's id is kept so consumers (PageModel, observe) can place and
    // track the text; without it every text line was an anonymous, unmeasurable node.
    const textNode: SnapshotNode = {
      role: 'text',
      name,
      ...(options.node.backendNodeId !== undefined ? { backendNodeId: options.node.backendNodeId } : {}),
      children: [],
    }
    return { nodes: [textNode], names }
  }

  const hasChildren = childNodes.length > 0
  const nameToUse = hasName && (childNames.has(name) || isSubstringOfAny(name, childNames)) ? '' : name
  const hasNameToUse = nameToUse.length > 0
  const isWrapper = SKIP_WRAPPER_ROLES.has(role)
  const isInteractive = INTERACTIVE_ROLES.has(role)
  const isContext = CONTEXT_ROLES.has(role)
  const passesRefFilter = !options.refFilter || options.refFilter({ role, name })
  const includeInteractive = isInteractive && passesRefFilter
  const shouldInclude = includeInteractive || isLabel || isContext || hasChildren
  if (!shouldInclude) {
    return { nodes: childNodes, names: childNames }
  }

  if (!includeInteractive && !isLabel && !isContext) {
    if (!hasChildren) {
      return { nodes: [], names: childNames }
    }
    return { nodes: childNodes, names: childNames }
  }

  if (isWrapper && !hasNameToUse) {
    if (!hasChildren) {
      return { nodes: [], names: childNames }
    }
    return { nodes: childNodes, names: childNames }
  }

  let baseLocator: string | undefined
  let ref: string | null = null
  if (includeInteractive) {
    const domInfo = options.node.backendNodeId ? options.domByBackendId.get(options.node.backendNodeId) : undefined
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null
    const isPromoted = options.node.backendNodeId != null && (options.promotedContentEditableIds?.has(options.node.backendNodeId) ?? false)
    baseLocator = buildBaseLocator({ role, name, stable, isPromotedContentEditable: isPromoted })
    ref = options.createRefForNode({ backendNodeId: options.node.backendNodeId, role, name })
  }

  const nodeEntry: SnapshotNode = {
    role,
    name: nameToUse,
    baseLocator,
    ref: ref ?? undefined,
    backendNodeId: options.node.backendNodeId,
    ...stateFields(options.node, options.domByBackendId),
    ...(nameToUse !== name ? { axName: name } : {}),
    children: childNodes,
  }
  const names = new Set(childNames)
  if (hasNameToUse) {
    names.add(nameToUse)
  }
  return { nodes: [nodeEntry], names }
}

export function filterFullSnapshotTree(options: {
  node: SnapshotNode
  ancestorNames: string[]
  refFilter?: (entry: { role: string; name: string }) => boolean
  domByBackendId: Map<Protocol.DOM.BackendNodeId, DomNodeInfo>
  promotedContentEditableIds?: Set<Protocol.DOM.BackendNodeId>
  createRefForNode: (options: {
    backendNodeId?: Protocol.DOM.BackendNodeId
    role: string
    name: string
  }) => string | null
}): { nodes: SnapshotNode[]; names: Set<string> } {
  const role = options.node.role
  const name = options.node.name
  const hasName = name.length > 0
  const nextAncestors = hasName ? [...options.ancestorNames, name] : options.ancestorNames

  const childResults = options.node.children.map((child) => {
    return filterFullSnapshotTree({
      node: child,
      ancestorNames: nextAncestors,
      refFilter: options.refFilter,
      domByBackendId: options.domByBackendId,
      promotedContentEditableIds: options.promotedContentEditableIds,
      createRefForNode: options.createRefForNode,
    })
  })
  const childNodes = childResults.flatMap((result) => {
    return result.nodes
  })
  const childNames = childResults.reduce((acc, result) => {
    result.names.forEach((childName) => {
      acc.add(childName)
    })
    return acc
  }, new Set<string>())

  if (options.node.ignored) {
    return { nodes: shiftIndent(childNodes, 1), names: childNames }
  }

  if (isTextRole(role)) {
    if (!hasName) {
      return { nodes: childNodes, names: childNames }
    }
    const isRedundantText = options.ancestorNames.some((ancestor) => {
      return ancestor.includes(name) || name.includes(ancestor)
    })
    if (isRedundantText) {
      return { nodes: childNodes, names: childNames }
    }
    const names = new Set(childNames)
    names.add(name)
    const textNode: SnapshotNode = {
      role: 'text',
      name,
      ...(options.node.backendNodeId !== undefined ? { backendNodeId: options.node.backendNodeId } : {}),
      ...(options.node.labels !== undefined ? { labels: options.node.labels } : {}),
      children: [],
    }
    return { nodes: [textNode], names }
  }

  const hasChildren = childNodes.length > 0
  const nameToUse = hasName && (childNames.has(name) || isSubstringOfAny(name, childNames)) ? '' : name
  const hasNameToUse = nameToUse.length > 0
  const isWrapper = SKIP_WRAPPER_ROLES.has(role)
  const isInteractive = INTERACTIVE_ROLES.has(role)
  const passesRefFilter = !options.refFilter || options.refFilter({ role, name })
  const includeInteractive = isInteractive && passesRefFilter
  const shouldInclude = includeInteractive || hasNameToUse || hasChildren
  if (!shouldInclude) {
    return { nodes: childNodes, names: childNames }
  }

  if (isWrapper && !hasNameToUse) {
    if (!hasChildren) {
      return { nodes: [], names: childNames }
    }
    return { nodes: childNodes, names: childNames }
  }

  let baseLocator: string | undefined
  let ref: string | null = null
  if (includeInteractive) {
    const domInfo = options.node.backendNodeId ? options.domByBackendId.get(options.node.backendNodeId) : undefined
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null
    const isPromoted = options.node.backendNodeId != null && (options.promotedContentEditableIds?.has(options.node.backendNodeId) ?? false)
    baseLocator = buildBaseLocator({ role, name, stable, isPromotedContentEditable: isPromoted })
    ref = options.createRefForNode({ backendNodeId: options.node.backendNodeId, role, name })
  }

  const nodeEntry: SnapshotNode = {
    role,
    name: nameToUse,
    baseLocator,
    ref: ref ?? undefined,
    backendNodeId: options.node.backendNodeId,
    ...stateFields(options.node, options.domByBackendId),
    ...(nameToUse !== name ? { axName: name } : {}),
    ...(options.node.labels !== undefined ? { labels: options.node.labels } : {}),
    children: childNodes,
  }
  const names = new Set(childNames)
  if (hasNameToUse) {
    names.add(nameToUse)
  }
  return { nodes: [nodeEntry], names }
}

function buildLocatorLineText({ line, locator }: { line: SnapshotLine; locator: string }): string {
  const prefix = '  '.repeat(line.indent ?? 0)
  const role = line.role ?? ''
  const name = line.name ?? ''
  const escapedName = name.replace(/"/g, '\\"')

  const hasRoleInLocator = role ? locator.includes(role) : false
  const hasNameInLocator = name ? locator.includes(escapedName) : false

  const parts: string[] = []
  if (role && !hasRoleInLocator) {
    parts.push(role)
  }
  if (name && !hasNameInLocator) {
    parts.push(`"${escapedName}"`)
  }

  const base = parts.length > 0 ? `${prefix}- ${parts.join(' ')}` : `${prefix}-`
  return `${base} ${locator}${line.suffix ?? ''}`
}

export function finalizeSnapshotOutput(
  lines: SnapshotLine[],
  nodes: SnapshotNode[],
  shortRefMap: Map<string, string>,
): { snapshot: string; tree: AriaSnapshotNode[] } {
  const locatorCounts = lines.reduce<Map<string, number>>((acc, line) => {
    if (!line.baseLocator) {
      return acc
    }
    acc.set(line.baseLocator, (acc.get(line.baseLocator) ?? 0) + 1)
    return acc
  }, new Map<string, number>())

  const locatorIndices = new Map<string, number>()
  const locatorSequence = lines.reduce<string[]>((acc, line) => {
    if (!line.baseLocator) {
      return acc
    }
    const count = locatorCounts.get(line.baseLocator) ?? 0
    const index = locatorIndices.get(line.baseLocator) ?? 0
    locatorIndices.set(line.baseLocator, index + 1)
    const locator = count > 1 ? `${line.baseLocator} >> nth=${index}` : line.baseLocator
    acc.push(locator)
    return acc
  }, [])

  let lineLocatorIndex = 0
  const snapshot = lines
    .map((line) => {
      let text = line.text
      if (line.baseLocator) {
        const locator = locatorSequence[lineLocatorIndex]
        lineLocatorIndex += 1
        text = buildLocatorLineText({ line, locator })
      }
      if (line.hasChildren) {
        text += ':'
      }
      return text
    })
    .join('\n')

  let nodeLocatorIndex = 0
  const applyLocators = (items: SnapshotNode[]): AriaSnapshotNode[] => {
    return items.map((item) => {
      const locator = item.baseLocator ? locatorSequence[nodeLocatorIndex++] : undefined
      const children = applyLocators(item.children)
      return {
        role: item.role,
        name: item.name,
        locator,
        ref: item.ref,
        shortRef: item.ref ? (shortRefMap.get(item.ref) ?? item.ref) : undefined,
        backendNodeId: item.backendNodeId,
        ...(item.states ? { states: item.states } : {}),
        ...(item.value !== undefined ? { value: item.value } : {}),
        ...(item.axName !== undefined ? { axName: item.axName } : {}),
        ...(item.labels !== undefined ? { labels: item.labels } : {}),
        children,
      }
    })
  }

  return { snapshot, tree: applyLocators(nodes) }
}

/**
 * Index a pierced `DOM.getDocument` tree, walking every node with its real parent: light
 * children, shadow roots (parent: the host), a same-process iframe's document (parent: the
 * iframe) and pseudo-elements. The subtree below any element therefore holds everything rendered
 * inside it. `DOM.getFlattenedDocument` cannot give that: it omits shadow-root nodes, so the
 * parent links of every shadow tree end at a node that is not in the list (measured on
 * Chromium 145).
 */
function buildDomIndex(root: Protocol.DOM.Node): {
  domByBackendId: Map<Protocol.DOM.BackendNodeId, DomNodeInfo>
  childrenByBackendId: Map<Protocol.DOM.BackendNodeId, Protocol.DOM.BackendNodeId[]>
} {
  const domByBackendId = new Map<Protocol.DOM.BackendNodeId, DomNodeInfo>()
  const childrenByBackendId = new Map<Protocol.DOM.BackendNodeId, Protocol.DOM.BackendNodeId[]>()
  const stack: Array<{ node: Protocol.DOM.Node; parent?: Protocol.DOM.Node }> = [{ node: root }]
  for (let entry = stack.pop(); entry; entry = stack.pop()) {
    const { node, parent } = entry
    domByBackendId.set(node.backendNodeId, {
      nodeId: node.nodeId,
      parentId: parent?.nodeId,
      backendNodeId: node.backendNodeId,
      nodeName: node.nodeName,
      attributes: toAttributeMap(node.attributes),
    })
    if (parent) {
      const siblings = childrenByBackendId.get(parent.backendNodeId)
      if (siblings) siblings.push(node.backendNodeId)
      else childrenByBackendId.set(parent.backendNodeId, [node.backendNodeId])
    }
    const nested = [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.pseudoElements ?? [])]
    if (node.contentDocument) nested.push(node.contentDocument)
    for (const child of nested) stack.push({ node: child, parent: node })
  }
  return { domByBackendId, childrenByBackendId }
}

function buildBackendIdSet(
  rootBackendId: Protocol.DOM.BackendNodeId,
  childrenByBackendId: Map<Protocol.DOM.BackendNodeId, Protocol.DOM.BackendNodeId[]>,
): Set<Protocol.DOM.BackendNodeId> {
  const result = new Set<Protocol.DOM.BackendNodeId>()
  const stack = [rootBackendId]
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    result.add(current)
    stack.push(...(childrenByBackendId.get(current) ?? []))
  }
  return result
}

function isTextRole(role: string): boolean {
  return role === 'statictext' || role === 'inlinetextbox'
}

// Per HTML spec, contenteditable is editable when the attribute is present
// with value "true", "" (empty string), or "plaintext-only". Bare attribute
// (no value) is also treated as empty string by the browser DOM parser.
function isContentEditable(value: string | undefined | null): boolean {
  if (value == null) {
    return false
  }
  const v = value.trim().toLowerCase()
  return v === '' || v === 'true' || v === 'plaintext-only'
}

function isSubstringOfAny(needle: string, haystack: Set<string>): boolean {
  for (const str of haystack) {
    if (str.includes(needle)) {
      return true
    }
  }
  return false
}

// ============================================================================
// Frame Resolution
// ============================================================================

/**
 * Resolve a FrameLocator to an actual Frame object. FrameLocator (returned by
 * locator.contentFrame()) is a scoping helper that doesn't have CDP methods like
 * frameId(). We need the real Frame from page.frames() for OOPIF session attachment.
 *
 * If a Frame is passed directly, it's returned as-is.
 * If a FrameLocator is passed, we find the matching Frame by locating the iframe
 * element and matching its src URL against page.frames().
 */
async function resolveFrame({ frame, page }: { frame?: Frame | FrameLocator; page: Page }): Promise<Frame | undefined> {
  if (!frame) {
    return undefined
  }
  // Frame has frameId(), FrameLocator does not
  if (typeof (frame as Frame).frameId === 'function') {
    return frame as Frame
  }
  // It's a FrameLocator — resolve to a Frame via the owner iframe element.
  // Use elementHandle().contentFrame() which returns the actual Frame object
  // directly from the <iframe> element, avoiding ambiguity when multiple
  // frames share the same origin (e.g. framer plugin iframes).
  const frameLocator = frame as FrameLocator
  const owner = frameLocator.owner()
  const handle = await owner.elementHandle()
  if (!handle) {
    throw new Error('Could not resolve FrameLocator to a Frame: iframe element not found')
  }
  const resolved = await handle.contentFrame()
  if (!resolved) {
    throw new Error('Could not resolve FrameLocator to a Frame: contentFrame() returned null')
  }
  return resolved
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Get an accessibility snapshot with utilities to look up refs for elements.
 * Uses the browser accessibility tree (CDP) and maps nodes to DOM attributes.
 *
 * Refs are generated from stable test IDs when available (data-testid, data-test-id, etc.)
 * or fall back to e1, e2, e3...
 *
 * @param page - Playwright page
 * @param locator - Optional locator to scope the snapshot to a subtree
 * @param refFilter - Optional filter for which elements get refs
 *
 * @example
 * ```ts
 * const { snapshot, getSelectorForRef } = await getAriaSnapshot({ page })
 * // Snapshot shows locators like [id="submit-btn"] or role=button[name="Submit"]
 * const selector = getSelectorForRef('submit-btn')
 * await page.locator(selector).click()
 * ```
 */
export async function getAriaSnapshot({
  page,
  frame,
  locator,
  refFilter,
  interactiveOnly = false,
  cdp,
}: {
  page: Page
  frame?: Frame | FrameLocator
  /** Scope to this element's subtree: a Locator (resolved with Playwright's script, debug mode only) or an element resolved from a ref. */
  locator?: ElementTarget
  refFilter?: (info: { role: string; name: string }) => boolean
  interactiveOnly?: boolean
  cdp?: ICDPSession
}): Promise<AriaSnapshotResult> {
  // Resolve FrameLocator to an actual Frame. FrameLocator (from locator.contentFrame())
  // is a scoping helper without CDP access. We need the real Frame from page.frames()
  // which has frameId().
  const resolvedFrame = await resolveFrame({ frame, page })
  const frameId = resolvedFrame?.frameId() ?? null

  // A cross-process iframe (OOPIF) has its OWN CDP session and must be asked directly;
  // a same-process iframe has none and is asked through the page session with a
  // `frameId` parameter. `getCDPSessionForFrame` is what tells the two apart, and the
  // distinction is not cosmetic — see its doc comment for the measured behaviour of
  // each. Getting it wrong returns the PARENT document's tree under the child's name.
  const frameSession = resolvedFrame ? await getCDPSessionForFrame({ frame: resolvedFrame }) : null
  const isOopif = frameSession !== null
  const pageSession = cdp ?? (await getCDPSessionForPage({ page }))
  const session: ICDPSession = frameSession ?? pageSession

  await withDeadline(session.send('DOM.enable'), SNAPSHOT_CDP_TIMEOUT_MS, 'enabling the DOM domain (DOM.enable)')
  await withDeadline(
    session.send('Accessibility.enable'),
    SNAPSHOT_CDP_TIMEOUT_MS,
    'enabling the Accessibility domain (Accessibility.enable)',
  )

  // Scope: the locator's element is identified by backendNodeId without writing to the page
  // (element-resolve.ts), and its subtree is taken from the pierced DOM tree's parent links,
  // which run through shadow roots and same-process iframe documents (see buildDomIndex).
  const scopeElement = locator ? await resolveElement({ target: locator, cdp: pageSession }) : null
  if (scopeElement) {
    const snapshotFrame = resolvedFrame ?? page.mainFrame()
    const owner = scopeElement.frame
    let inside = false
    for (let current: Frame | null = owner; current; current = current.parentFrame()) {
      if (current === snapshotFrame) {
        inside = true
        break
      }
    }
    if (!inside) {
      throw new Error(
        `getAriaSnapshot: the locator's element is in frame ${scopeElement.frameId} (${owner.url()}), ` +
          `which is not ${resolvedFrame ? `the requested frame ${frameId} or inside it` : 'part of this page'}. ` +
          "Pass a locator inside the snapshotted frame, or pass that element's own frame as `frame`.",
      )
    }
    if (scopeElement.ownSession !== isOopif) {
      throw new Error(
        `getAriaSnapshot: the locator's element is in frame ${scopeElement.frameId} (${owner.url()}), ` +
          `which runs in ${scopeElement.ownSession ? 'its own renderer process' : 'the page process'} while the ` +
          `${resolvedFrame ? `requested frame ${frameId}` : 'page'} runs in ${isOopif ? 'its own' : 'the page'} process, ` +
          "so one DOM read cannot contain both. Pass the element's own frame as `frame`.",
      )
    }
  }

  const { root: domRoot } = await withDeadline(
    session.send('DOM.getDocument', { depth: -1, pierce: true }),
    SNAPSHOT_CDP_TIMEOUT_MS,
    'reading the DOM (DOM.getDocument)',
  )
  const { domByBackendId, childrenByBackendId } = buildDomIndex(domRoot)

  const scopeRootBackendId = scopeElement?.backendNodeId ?? null
  let allowedBackendIds: Set<Protocol.DOM.BackendNodeId> | null = null
  if (scopeElement) {
    if (!domByBackendId.has(scopeElement.backendNodeId)) {
      throw new Error(
        `getAriaSnapshot: the locator's element <${scopeElement.node.localName}> (backendNodeId ` +
          `${scopeElement.backendNodeId}) is not in the document DOM.getDocument returned: it was removed ` +
          'between resolving the locator and reading the DOM. Take the snapshot again once the page settles.',
      )
    }
    allowedBackendIds = buildBackendIdSet(scopeElement.backendNodeId, childrenByBackendId)
  }

  // On the OOPIF's own session the document IS the frame, so scoping by frameId is
  // both unnecessary and wrong (the parent's frame id is unknown there). On the page
  // session an unscoped call would return the TOP document, so `frameId` is required
  // whenever a frame was asked for.
  const axParams = isOopif ? undefined : frameId ? { frameId } : undefined
  const { nodes: axNodes } = await withDeadline(
    session.send('Accessibility.getFullAXTree', axParams),
    SNAPSHOT_CDP_TIMEOUT_MS,
    'reading the accessibility tree (Accessibility.getFullAXTree)',
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The one failure that used to be invisible: a cross-origin frame that Playwright
    // holds no session for (so `getCDPSessionForFrame` returned null) is unreachable
    // from the page session. Say so instead of falling back to the parent's tree.
    if (frameId && /Frame with the given frameId is not found/i.test(message)) {
      throw new Error(
        `getAriaSnapshot: frame ${frameId} (${resolvedFrame?.url() ?? 'unknown url'}) is not reachable from the ` +
          `page's CDP session, and Playwright holds no separate session for it either. It is a cross-process ` +
          `iframe whose target was never attached — through the relay, iframe targets are not in ` +
          `connectedTargets, so no session exists to ask. Refusing to return the parent document's tree in its ` +
          `place. Original protocol error: ${message}`,
      )
    }
    throw error
  })

  const axById = new Map<Protocol.Accessibility.AXNodeId, Protocol.Accessibility.AXNode>()
  for (const node of axNodes) {
    axById.set(node.nodeId, node)
  }

  // Index AX nodes by backendDOMNodeId for O(1) lookups during promotion
  // and root finding (instead of repeated O(n) axNodes.find() calls)
  const axByBackendId = new Map<Protocol.DOM.BackendNodeId, Protocol.Accessibility.AXNode>()
  for (const node of axNodes) {
    if (node.backendDOMNodeId) {
      axByBackendId.set(node.backendDOMNodeId, node)
    }
  }

  // Promote contenteditable elements that Chrome's AX tree doesn't classify as
  // interactive. Rich text editors (ProseMirror, Tiptap, Slate, Lexical, etc.) use
  // bare <div contenteditable="true"> without role="textbox", so Chrome reports
  // them as "generic" and they become invisible in the snapshot. We detect these
  // via the DOM tree and override the AX role to "textbox" so they appear as
  // interactive elements the AI can target.
  //
  // The "generic" is MEASURED, not inferred from the frameworks' behaviour: on
  // Chromium 145 `Accessibility.getFullAXTree` reports a bare
  // `<div contenteditable="true">` with `role.value === 'generic'` and
  // `ignored: false`, while the same div with an explicit `role="textbox"` reports
  // `'textbox'`. `generic` is in SKIP_WRAPPER_ROLES, so without this promotion the node
  // is dropped as a wrapper and the editor is simply absent from the snapshot.
  const promotedContentEditableIds = new Set<Protocol.DOM.BackendNodeId>()
  for (const [, domInfo] of domByBackendId) {
    if (!isContentEditable(domInfo.attributes.get('contenteditable'))) {
      continue
    }
    const axNode = axByBackendId.get(domInfo.backendNodeId)
    if (!axNode) {
      continue
    }
    const currentRole = getAxRole(axNode)
    if (INTERACTIVE_ROLES.has(currentRole)) {
      continue
    }
    axNode.role = { type: 'role', value: 'textbox' }
    promotedContentEditableIds.add(domInfo.backendNodeId)
  }

  const findRootAxNodeId = (): Protocol.Accessibility.AXNodeId | null => {
    if (scopeRootBackendId) {
      const scoped = axByBackendId.get(scopeRootBackendId)
      if (scoped) {
        return scoped.nodeId
      }
    }
    const rootWebArea = axNodes.find((node) => {
      return getAxRole(node) === 'rootwebarea'
    })
    if (rootWebArea) {
      return rootWebArea.nodeId
    }
    const webArea = axNodes.find((node) => {
      return getAxRole(node) === 'webarea'
    })
    if (webArea) {
      return webArea.nodeId
    }
    const topLevel = axNodes.find((node) => {
      return !node.parentId
    })
    return topLevel ? topLevel.nodeId : null
  }

  const rootAxNodeId = findRootAxNodeId()

  const refCounts = new Map<string, number>()
  let fallbackCounter = 0
  const refs: AriaRefDraft[] = []

  const createRefForNode = (options: {
    backendNodeId?: Protocol.DOM.BackendNodeId
    role: string
    name: string
  }): string | null => {
    if (!INTERACTIVE_ROLES.has(options.role)) {
      return null
    }

    const domInfo = options.backendNodeId ? domByBackendId.get(options.backendNodeId) : undefined
    const stable = domInfo ? getStableRefFromAttributes(domInfo.attributes) : null
    let baseRef = stable?.value
    if (!baseRef) {
      fallbackCounter += 1
      baseRef = `e${fallbackCounter}`
    }

    const count = refCounts.get(baseRef) ?? 0
    refCounts.set(baseRef, count + 1)
    const ref = count === 0 ? baseRef : `${baseRef}-${count + 1}`

    let selector: string | undefined
    if (stable && count === 0) {
      selector = buildLocatorFromStable(stable)
    }
    // For promoted contenteditable elements without a stable selector, store
    // [contenteditable="true"] so getSelectorForRef() doesn't fall back to
    // role=textbox which Playwright can't match on bare contenteditable divs.
    if (!selector && options.backendNodeId != null && promotedContentEditableIds.has(options.backendNodeId)) {
      selector = '[contenteditable="true"]'
    }

    refs.push({ ref, role: options.role, name: options.name, selector, backendNodeId: options.backendNodeId })
    return ref
  }

  const isNodeInScope = (node: Protocol.Accessibility.AXNode): boolean => {
    if (!allowedBackendIds) {
      return true
    }
    if (!node.backendDOMNodeId) {
      return false
    }
    return allowedBackendIds.has(node.backendDOMNodeId)
  }

  const nameSources = controlNameSources(axById)
  let snapshotNodes: SnapshotNode[] = []
  if (rootAxNodeId) {
    const rootNode = axById.get(rootAxNodeId)
    const rootRole = rootNode ? getAxRole(rootNode) : ''
    const rawRoots =
      rootNode && (rootRole === 'rootwebarea' || rootRole === 'webarea') && rootNode.childIds
        ? rootNode.childIds
            .map((childId) => {
              return buildRawSnapshotTree({ nodeId: childId, axById, isNodeInScope, nameSources })
            })
            .filter(isTruthy)
        : [buildRawSnapshotTree({ nodeId: rootAxNodeId, axById, isNodeInScope, nameSources })].filter(isTruthy)

    const filtered = rawRoots.flatMap((rawNode) => {
      if (interactiveOnly) {
        return filterInteractiveSnapshotTree({
          node: rawNode,
          ancestorNames: [],
          labelContext: false,
          refFilter,
          domByBackendId,
          promotedContentEditableIds,
          createRefForNode,
        }).nodes
      }
      return filterFullSnapshotTree({
        node: rawNode,
        ancestorNames: [],
        refFilter,
        domByBackendId,
        promotedContentEditableIds,
        createRefForNode,
      }).nodes
    })
    snapshotNodes = filtered
  }

  const snapshotLines = buildSnapshotLines(snapshotNodes)

  const shortRefMap = buildShortRefMap({ refs })
  const finalized = finalizeSnapshotOutput(snapshotLines, snapshotNodes, shortRefMap)
  const refsWithShortRef: Array<AriaRef & { selector?: string }> = refs.map((entry) => {
    return {
      ...entry,
      shortRef: shortRefMap.get(entry.ref) ?? entry.ref,
    }
  })
  const result = { snapshot: finalized.snapshot, tree: finalized.tree, refs: refsWithShortRef }

  // Build refToElement map
  const refToElement = new Map<string, { role: string; name: string; shortRef: string }>()
  const refToSelector = new Map<string, string>()
  for (const { ref, role, name, shortRef } of result.refs) {
    if (!refFilter || refFilter({ role, name })) {
      refToElement.set(ref, { role, name, shortRef })
    }
  }

  for (const { ref, selector } of result.refs) {
    if (!selector) {
      continue
    }
    refToSelector.set(ref, selector)
  }

  const snapshot = result.snapshot

  const getSelectorForRef = (ref: string): string | null => {
    const mapped = refToSelector.get(ref)
    if (mapped) {
      return mapped
    }
    const info = refToElement.get(ref)
    if (!info) {
      return null
    }
    const escapedName = info.name.replace(/"/g, '\\"')
    return `role=${info.role}[name="${escapedName}"]`
  }

  const getRefsForLocators = async (locators: Array<Locator | ElementHandle>): Promise<Array<AriaRef | null>> => {
    if (locators.length === 0) {
      return []
    }

    const targetHandles = await Promise.all(
      locators.map(async (loc) => {
        try {
          return 'elementHandle' in loc
            ? await (loc as Locator).elementHandle({ timeout: 1000 })
            : (loc as ElementHandle)
        } catch {
          return null
        }
      }),
    )

    const matchingRefs = await page.evaluate(
      ({ targets, refData }) => {
        return targets.map((target) => {
          if (!target) {
            return null
          }

          const testIdAttrs = [
            'data-testid',
            'data-test-id',
            'data-test',
            'data-cy',
            'data-pw',
            'data-qa',
            'data-e2e',
            'data-automation-id',
          ]
          for (const attr of testIdAttrs) {
            const value = target.getAttribute(attr)
            if (value) {
              const match = refData.find((ref) => {
                return ref.ref === value || ref.ref.startsWith(value)
              })
              if (match) {
                return match.ref
              }
            }
          }

          const id = target.getAttribute('id')
          if (id) {
            const match = refData.find((ref) => {
              return ref.ref === id || ref.ref.startsWith(id)
            })
            if (match) {
              return match.ref
            }
          }

          return null
        })
      },
      {
        targets: targetHandles,
        refData: result.refs,
      },
    )

    return matchingRefs.map((ref) => {
      if (!ref) {
        return null
      }
      const info = refToElement.get(ref)
      return info ? { ...info, ref } : null
    })
  }

  return {
    snapshot,
    tree: result.tree,
    refs: result.refs,
    refToElement,
    refToSelector,
    getSelectorForRef,
    getRefsForLocators,
    getRefForLocator: async (loc) => (await getRefsForLocators([loc]))[0],
    getRefStringForLocator: async (loc) => (await getRefsForLocators([loc]))[0]?.ref ?? null,
  }
}

function isTruthy<T>(value: T): value is NonNullable<T> {
  return Boolean(value)
}

// Re-export for backward compatibility
export { getAriaSnapshot as getAriaSnapshotWithRefs }
