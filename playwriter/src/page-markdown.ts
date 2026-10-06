/**
 * Extract page content as markdown using Mozilla Readability.
 *
 * Readability (the Firefox Reader View algorithm) picks the main content; its HTML is then
 * rendered to light markdown — `#` headings, `-`/`1.` lists, `>` quotes, fenced `pre`,
 * `|`-joined table rows — so a text-only model can see the page's structure, ask for the
 * heading outline only, or keep just the sections it cares about. When Readability finds
 * no article, the visible page is rendered the same way. Every result starts with the
 * source it came from and the word counts of both (`source: article — …`).
 *
 * Both read only what is on screen. The content is a copy of the page's flat tree — open
 * shadow roots and slotted content included — built from the live nodes that pass
 * `checkVisibility()`, so a hidden tab panel, a `display:none` error template or a closed
 * `<details>` body never comes out as content.
 *
 * Iframes are read where they sit. Every document — the page and each frame in it, same-process
 * or out-of-process, nested to any depth — is copied and rendered by its OWN frame's isolated
 * world. Where the copy of a document meets a rendered frame owner (`<iframe>`, `<frame>`, an
 * `<object>` showing a document) it leaves a placeholder holding a per-call nonce. Which frame a
 * placeholder stands for is known by element identity, not by URL or name: the owner elements of
 * the document's child frames (`DOM.getFrameOwner`, in that document's session) are handed to its
 * extraction as nodes. Each frame's markdown is then stitched in as text at its placeholder, under
 * `[iframe "title"]` and above `[end of iframe "title"]`; a frame that cannot be read leaves one line,
 * `[iframe "title"] not read: why`. An owner whose box is not rendered (or not `visibility: visible`)
 * shows nothing and is left out like any hidden content. Readability reads the top document only,
 * placeholders included, and its article is used only when it keeps every frame that shows text.
 *
 * The page under test is never modified: everything runs in our CDP isolated worlds (a
 * separate JS realm per frame that page scripts cannot see), each copy lives in a detached
 * document with no browsing context (no script, custom-element constructor or image fetch
 * runs there), and the article HTML is rendered inside an inert document.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@xmorse/playwright-core'
import { createSmartDiff } from './diff-utils.js'
import type { FrameEntry, FrameHandle, PageFrames, UnreadableFrame } from './page-frames.js'

/** What a frame's isolated world is called with, besides the owner elements of the frame's child frames. */
interface ExtractArgs {
  /** Per call: the placeholder of slot n is `\uE000<nonce>:<n>\uE001`, which no page text holds. */
  nonce: string
  /** Also find the article with Readability: the top document only, which loads the bundle for it. */
  article: boolean
}

/** A rendered element of the document that shows another document, in flat-tree order. */
interface FrameSlot {
  /** Its index among the owner elements the extraction was given; null for an `<iframe>`/`<frame>` that is none of them. */
  owner: number | null
  /** Lowercase tag name: `iframe`, `frame`, or `object`/`embed` when one shows a frame. */
  tag: string
  /** Its `title`, else `aria-label`, else `name` attribute, whitespace collapsed; '' when none. */
  label: string
  /** Its resolved `src`; '' when none (and on an `<object>`). */
  src: string
}

interface ArticleMetadata {
  title: string | null
  /** Article byline */
  author: string | null
  /** Article excerpt; null when it is just the opening of the content. */
  excerpt: string | null
  siteName: string | null
  publishedTime: string | null
}

/** Readability's verdict on the visible copy: the article as light markdown, placeholders included, or why there is none. */
type ArticleReading = (ArticleMetadata & { found: true; content: string }) | { found: false; noArticle: string }

/** What a frame's isolated world hands back for its document. */
interface ExtractedDocument {
  /** The rendered flat tree as light markdown (headings, lists, quotes, code blocks), a placeholder per slot. */
  visible: string
  slots: FrameSlot[]
  /** `document.title`. */
  title: string
  /** Null unless `ExtractArgs.article`. */
  article: ArticleReading | null
}

/** Page -> last extracted markdown. The diff baseline for `showDiffSinceLastCall`. */
export type MarkdownDiffStore = WeakMap<Page, string>

/** What sandbox code asks for. `page` defaults to the controlled page in the executor. */
export interface PageMarkdownRequest {
  page?: Page
  /** String or regex to filter content (returns matching lines with context) */
  search?: string | RegExp
  /** Return diff since last call for this page */
  showDiffSinceLastCall?: boolean
  /** Return only the heading lines (levels kept), to see the page's structure cheaply. */
  outline?: boolean
  /** Keep only the sections whose heading contains this text (case-insensitive), each with its sub-sections. */
  filter?: string
}

export interface GetPageMarkdownOptions extends PageMarkdownRequest {
  page: Page
  /**
   * Where the diff baseline lives, owned by the caller: the executor passes its own
   * per-session store, for the same reason `getCleanHTML` takes one — a module-global
   * baseline is shared by every session in the relay process, so two agents driving the
   * same `Page` would each be told "no changes since last call" about the other's work.
   */
  diffStore: MarkdownDiffStore
  /** The page's frames (the probe's `PageFrames`): each document is read in its own frame's isolated world. */
  frames: PageFrames
}

/**
 * Measured in headless Chromium on a 490 KB article (200 sections, 2000 paragraphs, 84k
 * words): ~400 ms for the first call (world creation + loading the bundle), ~300 ms after
 * (visible flat-tree copy, Readability, rendering both). The
 * cap is for a page whose main thread is busy or blocked by a native dialog, which
 * would otherwise hang the call forever.
 */
const EXTRACT_TIMEOUT_MS = 20_000

// Cache for the bundled readability code
let readabilityCode: string | null = null

function getReadabilityCode(): string {
  if (readabilityCode) {
    return readabilityCode
  }
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  const readabilityPath = path.join(currentDir, '..', 'dist', 'readability.js')
  readabilityCode = fs.readFileSync(readabilityPath, 'utf-8')
  return readabilityCode
}

function isRegExp(value: unknown): value is RegExp {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RegExp).test === 'function' &&
    typeof (value as RegExp).exec === 'function'
  )
}

/*
 * The DOM and Readability shapes the in-world renderer reads. The package compiles without
 * lib.dom (only `document` is ambient, untyped), so they are declared here.
 */
interface DomNode {
  nodeType: number
  nodeValue: string | null
  textContent: string | null
  childNodes: ArrayLike<DomNode>
  appendChild(child: DomNode): DomNode
  getRootNode(): DomNode
}
interface DomElement extends DomNode {
  tagName: string
  children: ArrayLike<DomElement>
  innerHTML: string
  /** Open shadow root; null for none or a closed one. */
  shadowRoot: DomNode | null
  getAttribute(name: string): string | null
  /** False when the element has no box: display:none here or above, a content-visibility:hidden ancestor, display:contents. */
  checkVisibility(): boolean
}
interface DomSlot extends DomElement {
  assignedNodes(): DomNode[]
}
interface DomDetails extends DomElement {
  open: boolean
}
interface DomFrameOwner extends DomElement {
  /** The resolved `src` of an `<iframe>`, `<frame>` or `<embed>`; absent on `<object>`. */
  src?: string
}
interface DomDocument extends DomNode {
  body: DomElement | null
  head: DomElement | null
  documentElement: DomElement | null
  title: string
  cloneNode(deep: false): DomDocument
  importNode(node: DomNode, deep: boolean): DomNode
  createElement(tagName: string): DomElement
  createTextNode(text: string): DomNode
  implementation: { createHTMLDocument(title: string): DomDocument }
}
interface DomWindow {
  getComputedStyle(element: DomElement): { display: string; visibility: string; contentVisibility: string }
}
interface ReadabilityArticle {
  title?: string | null
  content?: string | null
  textContent?: string | null
  excerpt?: string | null
  byline?: string | null
  siteName?: string | null
  lang?: string | null
  publishedTime?: string | null
}
interface ReadabilityApi {
  isProbablyReaderable(document: unknown): boolean
  Readability: new (document: unknown) => { parse(): ReadabilityArticle | null }
}
interface WorldGlobal {
  /** Set by the Readability bundle in the world that loaded it. */
  __readability?: ReadabilityApi
}

/**
 * Runs in a frame's isolated world as `fn(args, ...owners)` (serialised with `toString`, so it
 * must stay self-contained). `owners`: the elements that embed the frame's child frames, null
 * where one no longer exists. `globalThis.__readability` there is the world's own global, set
 * by the Readability bundle.
 */
function extractDocument(args: ExtractArgs, owners: Array<DomElement | null>): ExtractedDocument {
  const SKIP: Record<string, true> = {
    SCRIPT: true,
    STYLE: true,
    NOSCRIPT: true,
    TEMPLATE: true,
    SVG: true,
    CANVAS: true,
    HEAD: true,
    TITLE: true,
    META: true,
    LINK: true,
    OBJECT: true,
    EMBED: true,
  }
  const BLOCK: Record<string, true> = {
    ADDRESS: true,
    ARTICLE: true,
    ASIDE: true,
    BODY: true,
    CAPTION: true,
    DD: true,
    DETAILS: true,
    DIALOG: true,
    DIV: true,
    DL: true,
    DT: true,
    FIELDSET: true,
    FIGCAPTION: true,
    FIGURE: true,
    FOOTER: true,
    FORM: true,
    HEADER: true,
    HGROUP: true,
    MAIN: true,
    NAV: true,
    P: true,
    SECTION: true,
    SUMMARY: true,
    TABLE: true,
    TBODY: true,
    TFOOT: true,
    THEAD: true,
  }

  /**
   * Light markdown for `root`, a detached tree: the visible copy of the page (hidden nodes
   * already left out) or the article HTML in an inert document.
   */
  const toMarkdown = (root: DomElement): string => {
    const blocks: Array<{ text: string; listItem: boolean }> = []
    let inline = ''
    let quoteDepth = 0
    let listDepth = 0
    let bullet: string | null = null
    let inHeading = false
    const counters: Array<number | null> = []

    const collapse = (text: string): string =>
      text
        .split('\n')
        .map((line) => line.replace(/[ \t\f\r\u00a0]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n')

    const push = (text: string, listItem: boolean): void => {
      const indent = listItem && listDepth > 1 ? '  '.repeat(listDepth - 1) : ''
      const quote = '> '.repeat(quoteDepth)
      blocks.push({ text: text.split('\n').map((line) => quote + indent + line).join('\n'), listItem })
    }

    const flush = (): void => {
      const text = collapse(inline)
      inline = ''
      if (!text) return
      if (bullet !== null) {
        push(bullet + text, true)
        bullet = null
      } else {
        push(text, listDepth > 0)
      }
    }

    const visitChildren = (element: DomElement): void => {
      for (const child of Array.from(element.childNodes)) visit(child)
    }

    const visit = (node: DomNode): void => {
      if (node.nodeType === 3) {
        inline += (node.nodeValue ?? '').replace(/\s+/g, ' ')
        return
      }
      if (node.nodeType !== 1) return
      // nodeType 1 is ELEMENT_NODE.
      const element = node as DomElement
      const tag = element.tagName.toUpperCase()
      if (SKIP[tag] === true) return

      if (tag === 'BR') {
        inline += '\n'
        return
      }
      const headingLevel = /^H([1-6])$/.exec(tag)
      if (headingLevel && !inHeading) {
        flush()
        inHeading = true
        visitChildren(element)
        inHeading = false
        const text = collapse(inline).replace(/\n/g, ' ')
        inline = ''
        if (text) {
          const outerBullet = bullet
          bullet = null
          push(`${'#'.repeat(Number(headingLevel[1]))} ${text}`, false)
          bullet = outerBullet
        }
        return
      }
      if (inHeading) {
        visitChildren(element)
        return
      }
      if (tag === 'PRE') {
        flush()
        const trimmed = (element.textContent ?? '').replace(/^\n+|\s+$/g, '')
        if (trimmed) push('```\n' + trimmed + '\n```', false)
        return
      }
      if (tag === 'HR') {
        flush()
        push('---', false)
        return
      }
      if (tag === 'UL' || tag === 'OL' || tag === 'MENU') {
        flush()
        listDepth++
        counters.push(tag === 'OL' ? 0 : null)
        visitChildren(element)
        flush()
        counters.pop()
        listDepth--
        return
      }
      if (tag === 'LI') {
        flush()
        const counter = counters.length > 0 ? counters[counters.length - 1] : null
        if (counter === null) {
          bullet = '- '
        } else {
          counters[counters.length - 1] = counter + 1
          bullet = `${counter + 1}. `
        }
        visitChildren(element)
        flush()
        bullet = null
        return
      }
      if (tag === 'BLOCKQUOTE') {
        flush()
        quoteDepth++
        visitChildren(element)
        flush()
        quoteDepth--
        return
      }
      if (tag === 'TR') {
        flush()
        const cells: string[] = []
        for (const cell of Array.from(element.children)) {
          inline = ''
          visit(cell)
          const text = collapse(inline).replace(/\n/g, ' ')
          if (text) cells.push(text)
        }
        inline = ''
        if (cells.length > 0) push(cells.join(' | '), false)
        return
      }
      if (tag === 'IMG') {
        const alt = (element.getAttribute('alt') ?? '').trim()
        if (alt) inline += ` ${alt} `
        return
      }
      if (BLOCK[tag] === true) {
        flush()
        visitChildren(element)
        flush()
        return
      }
      visitChildren(element)
      if (tag === 'TD' || tag === 'TH') inline += ' '
    }

    visit(root)
    flush()
    let markdown = ''
    blocks.forEach((block, index) => {
      if (index > 0) markdown += block.listItem && blocks[index - 1].listItem ? '\n' : '\n\n'
      markdown += block.text
    })
    return markdown
  }

  // The isolated world is a window realm: getComputedStyle reads the page's real layout.
  const view = globalThis as unknown as DomWindow
  const live: DomDocument = document
  // A shallow clone of the document keeps its URL (Readability resolves links against it)
  // and has no browsing context: nothing imported into it runs, upgrades or loads.
  const copy = live.cloneNode(false)

  const ownerIndex = new Map<DomElement, number>()
  owners.forEach((owner, index) => {
    if (owner) ownerIndex.set(owner, index)
  })
  const slots: FrameSlot[] = []
  /** A block holding the placeholder of the document `element` shows; the caller puts that document's markdown there. */
  const slotPlaceholder = (element: DomElement, tag: string, owner: number | null): DomElement => {
    const label =
      [element.getAttribute('title'), element.getAttribute('aria-label'), element.getAttribute('name')]
        .map((value) => (value ?? '').replace(/\s+/g, ' ').trim())
        .find((value) => value !== '') ?? ''
    slots.push({ owner, tag: tag.toLowerCase(), label, src: (element as DomFrameOwner).src ?? '' })
    const placeholder = copy.createElement('div')
    placeholder.appendChild(copy.createTextNode(`\uE000${args.nonce}:${slots.length - 1}\uE001`))
    return placeholder
  }

  /** The element's children in the flat tree: its open shadow root's, or a slot's assigned nodes. */
  const flatChildren = (element: DomElement, tag: string): DomNode[] => {
    if (element.shadowRoot) return Array.from(element.shadowRoot.childNodes)
    // A slot in a shadow tree shows the nodes assigned to it; with none, its own fallback children.
    // nodeType 11 is DOCUMENT_FRAGMENT_NODE: the slot's root is a shadow root.
    if (tag === 'SLOT' && element.getRootNode().nodeType === 11) {
      const assigned = (element as DomSlot).assignedNodes()
      if (assigned.length > 0) return assigned
    }
    return Array.from(element.childNodes)
  }

  /**
   * Append to `target` a copy of `node` and its rendered flat-tree descendants. `textShown`:
   * the parent's own text is painted (computed `visibility` is `visible`, and its content is
   * not skipped). `contentSkipped`: the nearest box skips its content (content-visibility:
   * hidden, a closed <details>) — what a display:contents child inherits.
   */
  const copyNode = (target: DomNode, node: DomNode, textShown: boolean, contentSkipped: boolean): void => {
    if (node.nodeType === 3) {
      if (textShown) target.appendChild(copy.createTextNode(node.nodeValue ?? ''))
      return
    }
    if (node.nodeType !== 1) return
    const element = node as DomElement
    const tag = element.tagName.toUpperCase()
    // Not content (the renderer skips it), but Readability reads JSON-LD metadata from scripts.
    if (tag === 'SCRIPT') {
      target.appendChild(copy.importNode(element, true))
      return
    }
    const style = view.getComputedStyle(element)
    if (element.checkVisibility()) {
      const owner = ownerIndex.get(element)
      if (owner !== undefined || tag === 'IFRAME' || tag === 'FRAME') {
        // Another document is drawn in this box; its own frame's world reads it. A box whose
        // `visibility` is not `visible` paints none of that document (visibility does not
        // inherit into it, so the document's own nodes would not say so).
        if (style.visibility === 'visible') target.appendChild(slotPlaceholder(element, tag, owner ?? null))
        return
      }
      // A closed <details> renders only its <summary>; its other children sit in a hidden slot.
      const skips = style.contentVisibility === 'hidden' || (tag === 'DETAILS' && !(element as DomDetails).open)
      const clone = copy.importNode(element, false)
      target.appendChild(clone)
      for (const child of flatChildren(element, tag)) copyNode(clone, child, style.visibility === 'visible' && !skips, skips)
      return
    }
    // No box of its own: display:contents (every <slot> included) lays its children out in its
    // place; anything else is hidden together with its subtree.
    if (style.display !== 'contents') return
    for (const child of flatChildren(element, tag)) {
      copyNode(target, child, style.visibility === 'visible' && !contentSkipped, contentSkipped)
    }
  }

  const html = live.documentElement
  if (html) {
    const htmlCopy = copy.importNode(html, false)
    copy.appendChild(htmlCopy)
    // The head is metadata (title, meta tags, JSON-LD) for Readability, never rendered content.
    if (live.head) htmlCopy.appendChild(copy.importNode(live.head, true))
    if (live.body) copyNode(htmlCopy, live.body, false, false)
  }

  const visibleBody = copy.body
  const visible = visibleBody ? toMarkdown(visibleBody) : ''
  const extracted = (article: ArticleReading | null): ExtractedDocument => ({ visible, slots, title: live.title, article })
  if (!args.article) return extracted(null)
  const noArticle = (why: string): ExtractedDocument => extracted({ found: false, noArticle: why })

  if (!visibleBody) return noArticle('the page has no rendered body')
  // The Readability bundle assigns `{ Readability, isProbablyReaderable }` to this world's global.
  const readability = (globalThis as WorldGlobal).__readability
  if (!readability) {
    throw new Error('Readability is not loaded in the isolated world')
  }
  // Readability rewrites the tree it is given; the copy is ours and already rendered above.
  if (!readability.isProbablyReaderable(copy)) {
    return noArticle('Readability does not judge the visible page to be an article')
  }
  const article = new readability.Readability(copy).parse()
  if (!article || !article.content) {
    return noArticle('Readability found no article content in the visible page')
  }

  // An inert document: no scripts run and no images load when the article HTML is parsed.
  const inert = live.implementation.createHTMLDocument('')
  const container = inert.createElement('div')
  container.innerHTML = article.content
  // Metadata Readability takes from body text (an <h1>, the first paragraph) can hold a placeholder; it is not text.
  const placeholders = new RegExp(`\uE000${args.nonce}:\\d+\uE001`, 'g')
  const text = (value: string | null | undefined): string => (value || '').replace(placeholders, ' ').replace(/\s+/g, ' ').trim()
  const plainText = text(article.textContent)
  const excerpt = text(article.excerpt)
  return extracted({
    found: true,
    content: toMarkdown(container),
    title: text(article.title) || null,
    author: text(article.byline) || null,
    excerpt: excerpt && !plainText.startsWith(excerpt) ? excerpt : null,
    siteName: article.siteName || null,
    publishedTime: article.publishedTime || null,
  })
}

// ---------------------------------------------------------------------------------------
// Outline and section filter.
//
// Ported from oh-my-pi (omp) `packages/coding-agent/src/tools/browser/readable.ts`
// (`markdownHeading`, `extractMarkdownOutline`, `filterMarkdownSections`), MIT License,
// Copyright (c) oh-my-pi contributors. Changed here: lines inside fenced code blocks are
// never taken for headings (a `# comment` in a shell snippet is not a section).
// ---------------------------------------------------------------------------------------

function markdownHeading(line: string): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
  return match ? { level: match[1].length, title: match[2] } : null
}

/** Per line: the heading it is, or null (also null for every line inside a ``` fence). */
function headingsByLine(lines: string[]): Array<{ level: number; title: string } | null> {
  let inFence = false
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return null
    }
    return inFence ? null : markdownHeading(line)
  })
}

/** Reduce Markdown to heading lines while preserving heading levels. */
export function extractMarkdownOutline(markdown: string): string {
  const lines = markdown.split('\n')
  const headings = headingsByLine(lines)
  return lines.filter((_, index) => headings[index] !== null).join('\n')
}

/** Keep complete Markdown sections selected by a heading substring. */
export function filterMarkdownSections(markdown: string, filter: string): string {
  const needle = filter.trim().toLocaleLowerCase()
  if (!needle) return markdown
  const lines = markdown.split('\n')
  const headings = headingsByLine(lines)
  const keep = new Uint8Array(lines.length)
  for (let index = 0; index < lines.length; index++) {
    const heading = headings[index]
    if (!heading || !heading.title.toLocaleLowerCase().includes(needle)) continue
    let end = index + 1
    while (end < lines.length) {
      const next = headings[end]
      if (next && next.level <= heading.level) break
      end++
    }
    keep.fill(1, index, end)
  }
  return lines
    .filter((_, index) => keep[index] === 1)
    .join('\n')
    .trim()
}

/** What one getPageMarkdown call knows of the page's frames. */
interface FrameReading {
  frames: PageFrames
  /** Every frame `PageFrames.list()` found, readable or not, by the id of the frame it is in. */
  children: Map<string, Array<FrameEntry | UnreadableFrame>>
  nonce: string
  /** Any placeholder of this call (global flag); group 1 is its slot. */
  placeholder: RegExp
}

/** A child frame of a document with its owner element, in that document's session id space. */
interface PlacedFrame {
  frame: FrameEntry | UnreadableFrame
  backendNodeId: number
}

/** What replaces a slot's placeholder. */
interface SlotBlock {
  /** How the markdown names the slot: `iframe "Card payment"`. */
  name: string
  markdown: string
  /** Words of the frame's content, its own frames included; 0 for a frame that was not read. */
  words: number
  /** The frame was read and shows no text: leaving it out loses nothing. */
  empty: boolean
}

/** A document read in its own frame's world, with the block for each of its slots. */
interface DocumentRead {
  extracted: ExtractedDocument
  blocks: SlotBlock[]
}

/**
 * Read the document of `handle` in that frame's own isolated world, then every frame it shows,
 * each in its own world (same-process and out-of-process alike), concurrently.
 */
async function readDocument(reading: FrameReading, handle: FrameHandle, article: boolean): Promise<DocumentRead> {
  const placed = await Promise.all(
    (reading.children.get(handle.frameId) ?? []).map(async (frame): Promise<PlacedFrame | null> => {
      try {
        return { frame, backendNodeId: (await reading.frames.owner(frame.frameId)).backendNodeId }
      } catch (error) {
        // Gone since the list (no element shows it now), or not readable anyway: an <iframe> still
        // rendered without a frame gets its own not-read line.
        if ('reason' in frame || frame.frame.isDetached()) return null
        throw error
      }
    }),
  )
  const owners = placed.filter((owner): owner is PlacedFrame => owner !== null)
  // One call loads Readability (only if this copy of the world lacks it) and extracts, so a
  // navigation that recreates the world between two calls cannot split them.
  const declaration =
    'function (args, ...owners) {\n' +
    (article ? `if (!globalThis.__readability) {\n${getReadabilityCode()}\n}\n` : '') +
    `return (${extractDocument.toString()})(args, owners)\n}`
  const args: ExtractArgs = { nonce: reading.nonce, article }
  const extracted = await handle.world.callFunctionOnNodes<ExtractedDocument>(
    owners.map((owner) => owner.backendNodeId),
    declaration,
    {
      args,
      timeoutMs: EXTRACT_TIMEOUT_MS,
      what: article ? 'extracting the page content with Readability' : `reading the iframe document ${handle.frame.url()}`,
    },
  )
  const blocks = await Promise.all(
    extracted.slots.map((slot) => readSlot(reading, slot, slot.owner === null ? null : owners[slot.owner].frame)),
  )
  return { extracted, blocks }
}

/** The block for one slot: its frame's markdown between `[iframe "title"]` and `[end of iframe "title"]`, or why it was not read. */
async function readSlot(reading: FrameReading, slot: FrameSlot, frame: FrameEntry | UnreadableFrame | null): Promise<SlotBlock> {
  const title = slot.label || (frame ? frame.url : slot.src)
  const name = title ? `${slot.tag} "${title}"` : `${slot.tag} with no title or URL`
  const notRead = (why: string): SlotBlock => ({ name, markdown: `[${name}] not read: ${why}`, words: 0, empty: false })
  if (!frame) return notRead('it was added or replaced while the page was being read')
  if ('reason' in frame) return notRead(frame.reason)
  let read: DocumentRead
  try {
    read = await readDocument(reading, await reading.frames.handle(frame.frameId), false)
  } catch (error) {
    if (frame.frame.isDetached()) return notRead('it was removed from the page while being read')
    return notRead(error instanceof Error ? error.message : String(error))
  }
  const content = stitchFrames(read.extracted.visible, read.blocks, reading.placeholder)
  if (!content) return { name, markdown: `[${name}] shows no text`, words: 0, empty: true }
  return {
    name,
    markdown: `[${name}]\n\n${content}\n\n[end of ${name}]`,
    words: wordsWithFrames(read.extracted.visible, read.blocks, reading.placeholder),
    empty: false,
  }
}

/** Quote marks, list indent and bullet that `toMarkdown` puts before a block's text. */
const LINE_PREFIX = /^((?:> )*)( *)((?:- |\d+\. )?)/

/**
 * `markdown` with each placeholder replaced by its slot's block. The block takes its
 * placeholder's line under the same quote marks and list indent (the bullet on its first line
 * only), so an iframe inside a list item or a blockquote stays inside it.
 */
function stitchFrames(markdown: string, blocks: readonly SlotBlock[], placeholder: RegExp): string {
  const lines: string[] = []
  for (const line of markdown.split('\n')) {
    // text, slot, text, slot, …, text
    const parts = line.split(placeholder)
    if (parts.length === 1) {
      lines.push(line)
      continue
    }
    const [lead = '', quote = '', indent = '', bullet = ''] = LINE_PREFIX.exec(line) ?? []
    const continuation = quote + indent + ' '.repeat(bullet.length)
    // Text before the placeholder (an iframe inside a heading) keeps a line of its own.
    let firstPrefix: string | null = parts[0] === lead ? lead : null
    if (firstPrefix === null) lines.push(parts[0].trimEnd())
    for (let index = 1; index < parts.length; index += 2) {
      blocks[Number(parts[index])].markdown.split('\n').forEach((blockLine, lineIndex) => {
        const prefix = lineIndex === 0 && firstPrefix !== null ? firstPrefix : continuation
        lines.push(blockLine ? prefix + blockLine : prefix.trimEnd())
      })
      firstPrefix = null
      const after = parts[index + 1].trim()
      if (after) lines.push(continuation + after)
    }
  }
  return lines.join('\n')
}

/**
 * Words of `markdown`: whitespace-separated tokens holding a letter or digit (markup like `#`,
 * `-`, `|` is not a word), each placeholder counted as its frame's content (the `[iframe …]`
 * lines around it are markup).
 */
function wordsWithFrames(markdown: string, blocks: readonly SlotBlock[], placeholder: RegExp): number {
  let words = markdown
    .replace(placeholder, ' ')
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token)).length
  for (const match of markdown.matchAll(placeholder)) words += blocks[Number(match[1])].words
  return words
}

/**
 * Extract page content as markdown using Mozilla Readability, every rendered iframe's content
 * inline where the iframe is (see the file header).
 *
 * Every result starts with `source: article — N words (visible page: M words)` or
 * `source: visible page — M words (no article: <why>)`, then the content or its view.
 * The diff baseline is always the full markdown of the page; `filter`, `outline` and
 * `search` are views of it. Like `search`, `filter`/`outline` turn the diff off by
 * default; asking for both diffs the view of the previous content against the view of
 * the current one.
 */
export async function getPageMarkdown(options: GetPageMarkdownOptions): Promise<string> {
  const { page, frames, diffStore } = options
  const listed = await frames.list()
  const children = new Map<string, Array<FrameEntry | UnreadableFrame>>()
  for (const frame of [...listed.frames, ...listed.unreadable]) {
    if (frame.parentId === null) continue
    const siblings = children.get(frame.parentId)
    if (siblings) siblings.push(frame)
    else children.set(frame.parentId, [frame])
  }
  const nonce = randomUUID()
  const placeholder = new RegExp(`\uE000${nonce}:(\\d+)\uE001`, 'g')
  const top = await readDocument({ frames, children, nonce, placeholder }, frames.main, true)
  const reading = top.extracted.article
  if (!reading) {
    throw new Error('Readability did not run on the top document')
  }
  const visible = stitchFrames(top.extracted.visible, top.blocks, placeholder)
  const visibleWords = wordsWithFrames(top.extracted.visible, top.blocks, placeholder)

  // The article is a part of the visible copy, placeholders included. It is used only when it
  // keeps every frame that shows text, so no frame content is dropped for being outside it.
  const kept = new Set(reading.found ? Array.from(reading.content.matchAll(placeholder), (match) => Number(match[1])) : [])
  const leftOut = reading.found ? top.blocks.filter((block, slot) => !block.empty && !kept.has(slot)).map((block) => block.name) : []
  const words = (count: number): string => `${count} word${count === 1 ? '' : 's'}`
  let sourceLine: string
  let content: string
  let metadata: ArticleMetadata
  if (reading.found && leftOut.length === 0) {
    content = stitchFrames(reading.content, top.blocks, placeholder)
    sourceLine = `source: article — ${words(wordsWithFrames(reading.content, top.blocks, placeholder))} (visible page: ${words(visibleWords)})`
    metadata = reading
  } else {
    const noArticle = reading.found ? `Readability's article leaves out ${leftOut.join(', ')}, which the page shows` : reading.noArticle
    content = visible
    sourceLine = `source: visible page — ${words(visibleWords)} (no article: ${noArticle})`
    metadata = { title: top.extracted.title || null, author: null, excerpt: null, siteName: null, publishedTime: null }
  }

  const lines: string[] = []

  if (metadata.title) {
    lines.push(`# ${metadata.title}`)
    lines.push('')
  }

  const byline: string[] = []
  if (metadata.author) {
    byline.push(`Author: ${metadata.author}`)
  }
  if (metadata.siteName) {
    byline.push(`Site: ${metadata.siteName}`)
  }
  if (metadata.publishedTime) {
    byline.push(`Published: ${metadata.publishedTime}`)
  }
  if (byline.length > 0) {
    lines.push(byline.join(' | '))
    lines.push('')
  }

  if (metadata.excerpt) {
    lines.push(`> ${metadata.excerpt}`)
    lines.push('')
  }

  lines.push(content)

  let markdown = lines.join('\n').trim()

  // Sanitize to remove unpaired surrogates that break JSON encoding
  markdown = markdown.toWellFormed?.() ?? markdown

  // Store snapshot and handle diffing
  const previousSnapshot = diffStore.get(page)
  diffStore.set(page, markdown)

  return `${sourceLine}\n\n${markdownView(markdown, previousSnapshot, options)}`
}

/** The part of `markdown` the call asked for: a diff against `previousSnapshot`, a filter/outline view, search hits, or all of it. */
function markdownView(markdown: string, previousSnapshot: string | undefined, options: GetPageMarkdownOptions): string {
  const {
    search,
    outline = false,
    filter,
    // Opt-in, like snapshot(): a second call returning a diff gets read as the whole page.
    showDiffSinceLastCall = false,
  } = options
  const toView = (content: string): string => {
    let view = content
    if (filter !== undefined) view = filterMarkdownSections(view, filter)
    if (outline) view = extractMarkdownOutline(view)
    return view
  }
  const view = toView(markdown)
  if (filter !== undefined && filter.trim() && !view) {
    return `No section heading contains "${filter.trim()}". Use outline: true to list the headings.`
  }
  if (outline && !view) {
    return 'No headings found in the page content.'
  }

  // Diff defaults off when search/filter/outline is provided, but agent can explicitly enable both
  if (showDiffSinceLastCall && previousSnapshot) {
    const diffResult = createSmartDiff({
      oldContent: toView(previousSnapshot),
      newContent: view,
      label: 'content',
    })
    if (diffResult.type === 'no-change') {
      return 'No changes since last call. Use showDiffSinceLastCall: false to see full content.'
    }
    return diffResult.content
  }

  // Handle search
  if (search) {
    const contentLines = view.split('\n')
    // A /g or /y regex keeps `lastIndex` between `test` calls and would skip matching lines.
    const pattern = isRegExp(search) ? new RegExp(search.source, search.flags.replace(/[gy]/g, '')) : null
    const needle = typeof search === 'string' ? search.toLowerCase() : ''
    const matchIndices: number[] = []
    for (let i = 0; i < contentLines.length; i++) {
      const line = contentLines[i]
      if (pattern ? pattern.test(line) : line.toLowerCase().includes(needle)) matchIndices.push(i)
    }

    if (matchIndices.length === 0) {
      return 'No matches found'
    }
    const MAX_MATCHES = 10
    const shown = matchIndices.slice(0, MAX_MATCHES)

    // Collect lines with 5 lines of context above and below each match
    const CONTEXT_LINES = 5
    const includedLines = new Set<number>()
    for (const idx of shown) {
      const start = Math.max(0, idx - CONTEXT_LINES)
      const end = Math.min(contentLines.length - 1, idx + CONTEXT_LINES)
      for (let i = start; i <= end; i++) {
        includedLines.add(i)
      }
    }

    // Build result with separators between non-contiguous sections
    const sortedIndices = [...includedLines].sort((a, b) => a - b)
    const resultLines: string[] = []
    for (let i = 0; i < sortedIndices.length; i++) {
      const lineIdx = sortedIndices[i]
      if (i > 0 && sortedIndices[i - 1] !== lineIdx - 1) {
        resultLines.push('---')
      }
      resultLines.push(contentLines[lineIdx])
    }

    // Matches past the first ten can still be on screen as context lines of an earlier one.
    const unshown = matchIndices.filter((index) => !includedLines.has(index)).length
    if (unshown > 0) {
      resultLines.push('---', `${unshown} more matching line${unshown === 1 ? '' : 's'} not shown (${matchIndices.length} in all); narrow the search or use filter.`)
    }
    return resultLines.join('\n')
  }

  return view
}
