/**
 * network-detail.ts — what Chrome reported about one request, for `net.request(id)` and
 * `net.har({ path })`: request and response headers, status text, sizes, timings, failure and CORS
 * reason, request body.
 *
 * Everything here is read from CDP Network events Chrome already sends on the sessions Playwright
 * enabled Network on (page-watch.ts journals them); nothing is sent to the page or the server.
 * Headers come in two versions. `Network.requestWillBeSent` / `responseReceived` carry the headers as
 * the renderer issued and saw them: Chrome adds Cookie, Host, Accept-Encoding and others when it sends a
 * request, and leaves Set-Cookie and other filtered headers out of the response it hands the page.
 * `Network.requestWillBeSentExtraInfo` / `responseReceivedExtraInfo` carry them exactly as they went on
 * and came off the wire, whenever the request went to the network (measured: Chrome 145 and 149
 * headless, through the playwriter extension too). The wire version is shown when Chrome reported it,
 * and the output says which one it is.
 *
 * Credential headers (Cookie, Set-Cookie, Authorization, Proxy-Authorization) are shown as
 * `<redacted, N chars>` unless the caller asks for secrets; the output says how.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Protocol } from 'devtools-protocol'
import { PageUnresponsiveError } from './isolated-world.js'
import { ModelFacingError, type NetworkRecord } from './probe-types.js'
import { VERSION } from './utils.js'
import { blockedByAllowedDomains } from './allowed-domains.js'

/** What Chrome reported about one request hop, as page-watch.ts keeps it. */
export interface RequestFacts {
  /** Headers as the renderer issued them (Network.requestWillBeSent). */
  requestHeaders?: Protocol.Network.Headers
  /** Headers exactly as sent on the wire (Network.requestWillBeSentExtraInfo); absent when Chrome did not report them. */
  sentHeaders?: Protocol.Network.Headers
  /** The request body Chrome reported with the request, as bytes. */
  postData?: Buffer
  /** Chrome said the request has a body. */
  hasPostData?: boolean
  /** The origin the request was made from: the document's (or worker's) whose URL Chrome named. */
  initiatorOrigin?: string
  /** Chrome's monotonic clock (seconds) when the request was issued and when it ended. */
  issuedTs?: number
  endedTs?: number
  statusText?: string
  /** Response headers as Chrome handed them to the page (Network.responseReceived, or the redirect response). */
  responseHeaders?: Protocol.Network.Headers
  /** Response headers exactly as received (Network.responseReceivedExtraInfo); absent when Chrome did not report them. */
  receivedHeaders?: Protocol.Network.Headers
  /** The HTTP version (Chrome's `protocol`: `http/1.1`, `h2`, `h3`, …). */
  protocol?: string
  /** `ip:port` of the server. */
  remoteAddress?: string
  timing?: Protocol.Network.ResourceTiming
  /** Bytes received for it, headers included (Network.loadingFinished `encodedDataLength`). */
  encodedBytes?: number
  /** Body bytes after decoding, summed over Network.dataReceived; absent when Chrome reported none. */
  bodyBytes?: number
  /** What Chrome said when it reported the request failed (Network.loadingFailed). */
  failure?: { errorText: string; canceled: boolean; blockedReason?: string; cors?: Protocol.Network.CorsErrorStatus }
}

/** One journaled hop as the detail views need it. */
export interface RequestView {
  record: NetworkRecord
  facts: RequestFacts
  mimeType?: string
  /** Id of the hop this one was redirected to. */
  redirectedTo?: string
  /** URL of the hop this one was redirected to. */
  redirectedToUrl?: string
}

const CREDENTIAL_HEADERS: Record<string, true> = { cookie: true, 'set-cookie': true, authorization: true, 'proxy-authorization': true }

const TEXTUAL_MIME_RE = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql)|image\/svg\+xml)/i

/** Whether a body of this MIME type is text. */
export function isTextualMime(mimeType: string | undefined): boolean {
  return mimeType !== undefined && TEXTUAL_MIME_RE.test(mimeType.split(';', 1)[0]!.trim())
}

/** What CORS rule a response broke, in Chrome's own terms (Network.CorsError), with the header value it named. */
export function corsDescription(status: Protocol.Network.CorsErrorStatus): string {
  const value = status.failedParameter
  const named = value ? ` (${value})` : ''
  // A string: Chrome 149 names reasons (InsecureLocalNetwork, …) the installed protocol types do not list yet.
  const code: string = status.corsError
  switch (code) {
    case 'DisallowedByMode':
      return 'the request was made in same-origin mode, which forbids other origins'
    case 'InvalidResponse':
      return 'the response could not be checked (it is not a valid HTTP response)'
    case 'WildcardOriginNotAllowed':
      return "Access-Control-Allow-Origin is '*', which a request with credentials may not use"
    case 'MissingAllowOriginHeader':
      return 'no Access-Control-Allow-Origin header'
    case 'MultipleAllowOriginValues':
      return `Access-Control-Allow-Origin has several values${named}`
    case 'InvalidAllowOriginValue':
      return `Access-Control-Allow-Origin has an invalid value${named}`
    case 'AllowOriginMismatch':
      return `Access-Control-Allow-Origin names another origin${named}`
    case 'InvalidAllowCredentials':
      return `Access-Control-Allow-Credentials is not 'true' on a request with credentials${named}`
    case 'CorsDisabledScheme':
      return `cross-origin requests are not supported for this scheme${named}`
    case 'PreflightInvalidStatus':
      return 'the preflight (OPTIONS) request was not answered with a success status'
    case 'PreflightDisallowedRedirect':
      return 'the preflight (OPTIONS) request was redirected, which is not allowed'
    case 'PreflightWildcardOriginNotAllowed':
      return "the preflight's Access-Control-Allow-Origin is '*', which a request with credentials may not use"
    case 'PreflightMissingAllowOriginHeader':
      return 'no Access-Control-Allow-Origin header on the preflight (OPTIONS) response'
    case 'PreflightMultipleAllowOriginValues':
      return `the preflight's Access-Control-Allow-Origin has several values${named}`
    case 'PreflightInvalidAllowOriginValue':
      return `the preflight's Access-Control-Allow-Origin has an invalid value${named}`
    case 'PreflightAllowOriginMismatch':
      return `the preflight's Access-Control-Allow-Origin names another origin${named}`
    case 'PreflightInvalidAllowCredentials':
      return `the preflight's Access-Control-Allow-Credentials is not 'true' on a request with credentials${named}`
    case 'PreflightMissingAllowExternal':
      return 'the preflight response has no Access-Control-Allow-Private-Network header (a request into a more private network)'
    case 'PreflightInvalidAllowExternal':
      return `the preflight's Access-Control-Allow-Private-Network header is invalid${named}`
    case 'InvalidAllowMethodsPreflightResponse':
      return `the preflight's Access-Control-Allow-Methods header is invalid${named}`
    case 'InvalidAllowHeadersPreflightResponse':
      return `the preflight's Access-Control-Allow-Headers header is invalid${named}`
    case 'MethodDisallowedByPreflightResponse':
      return `the preflight's Access-Control-Allow-Methods does not allow the method${named}`
    case 'HeaderDisallowedByPreflightResponse':
      return `the preflight's Access-Control-Allow-Headers does not allow the header${named}`
    case 'RedirectContainsCredentials':
      return `the request was redirected to an address with a user name or password in it${named}`
    case 'InsecureLocalNetwork':
      return 'a page that is not a secure context may not reach the local network'
    case 'InvalidLocalNetworkAccess':
      return `the request into the local network is not allowed${named}`
    case 'NoCorsRedirectModeNotFollow':
      return 'a no-cors request whose redirect mode is not "follow" was redirected'
    case 'LocalNetworkAccessPermissionDenied':
      return 'the user did not allow this site to reach the local network'
  }
  // A reason this protocol version does not know yet: Chrome's own name for it.
  return `Chrome's CORS error ${String(status.corsError)}${named}`
}

/** How Chrome's own CORS console message names what made a request: `fetch`, `XMLHttpRequest`, or the resource type. */
function requestKind(resourceType: string | undefined): string {
  if (resourceType === 'Fetch') return 'fetch'
  if (resourceType === 'XHR') return 'XMLHttpRequest'
  return resourceType ? resourceType.toLowerCase() : 'request'
}

/** A header's value by case-insensitive name. */
export function headerValue(headers: Protocol.Network.Headers | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value)
  }
  return undefined
}

/**
 * Why Chrome says a request failed, as the journal records it. A CORS block names Chrome's reason, the
 * origin it was made from and the address (Chrome's `errorText` for it is only `net::ERR_FAILED`). Chrome's
 * `errorText` is empty for a request it blocked (measured: GitHub's fetch whose cross-origin redirect the
 * page's CSP refused came with `errorText: ""` and `blockedReason: "csp"`); the block reason is the reason then.
 */
export function failureText({
  event,
  url,
  resourceType,
  origin,
}: {
  event: Protocol.Network.LoadingFailedEvent
  url: string
  resourceType: string | undefined
  /** The origin it was made from, when known. */
  origin: string | undefined
}): string {
  if (event.corsErrorStatus) {
    return `CORS: ${corsDescription(event.corsErrorStatus)} (${requestKind(resourceType ?? event.type)} from ${origin ?? 'an origin Chrome did not name'} to ${url})`
  }
  if (event.canceled) return 'canceled'
  // Chrome names a request DevTools failed `net::ERR_BLOCKED_BY_CLIENT.Inspector` (measured on 149).
  if (event.errorText.startsWith('net::ERR_BLOCKED_BY_CLIENT')) return blockedByAllowedDomains(event.requestId) ?? event.errorText
  if (event.errorText) return event.errorText
  if (event.blockedReason) return `blocked: ${event.blockedReason}`
  return 'failed; Chrome gave no reason'
}

/** The origin of a URL Chrome named, or undefined when it has none (about:blank, a data: URL). */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

/** `headers` with credential headers replaced by `<redacted, N chars>` unless `secrets`; the names redacted. */
export function redactHeaders(headers: Protocol.Network.Headers, secrets: boolean): { headers: Record<string, string>; redacted: string[] } {
  const out: Record<string, string> = {}
  const redacted: string[] = []
  for (const [name, raw] of Object.entries(headers)) {
    const value = String(raw)
    if (!secrets && CREDENTIAL_HEADERS[name.toLowerCase()] === true) {
      out[name] = `<redacted, ${value.length} chars>`
      redacted.push(name)
    } else {
      out[name] = value
    }
  }
  return { headers: out, redacted }
}

/** The request body as text when it is text (UTF-8 that survives a round trip), else base64. */
function bodyOf(bytes: Buffer): { text: string; base64Encoded: boolean } {
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? { text, base64Encoded: false } : { text: bytes.toString('base64'), base64Encoded: true }
}

/** The response body net.request shows, or why there is none. */
export type BodyRead = { status?: number; mimeType?: string; body: string; truncated: boolean; base64Encoded: boolean } | { unavailable: string }

/** The whole detail `net.request(id)` returns. */
export interface RequestDetail extends NetworkRecord {
  redirectedTo?: string
  mimeType?: string
  protocol?: string
  remoteAddress?: string
  requestHeaders: Record<string, string>
  requestHeadersAre: string
  requestBody?: string
  requestBodyBase64Encoded?: true
  requestBodyNote?: string
  responseHeaders?: Record<string, string>
  responseHeadersAre?: string
  sizes: { transferredBytes?: number; bodyBytes?: number }
  failureText?: string
  canceled?: true
  blockedReason?: string
  cors?: Protocol.Network.CorsErrorStatus
  note?: string
  body?: string
  truncated?: boolean
  base64Encoded?: boolean
  noBody?: string
  redacted?: string
}

const SENT = 'as sent on the wire'
const ISSUED =
  'as the page issued them: Chrome did not report the headers it sent for this request (it adds Cookie, Host, Accept-Encoding and others when it sends one)'
const RECEIVED = 'as received on the wire'
const PARSED =
  'as Chrome handed them to the page: Chrome did not report the raw response headers for this request (Set-Cookie and other filtered headers are left out)'

/** `net.request(id)`'s answer from a journaled hop, its request body (when Chrome holds one) and its response body read. */
export function describeRequest({ view, body, requestBody, secrets }: { view: RequestView; body: BodyRead; requestBody: Buffer | { unavailable: string } | null; secrets: boolean }): RequestDetail {
  const { record, facts } = view
  const redactedNames = new Set<string>()
  const request = redactHeaders(facts.sentHeaders ?? facts.requestHeaders ?? {}, secrets)
  for (const name of request.redacted) redactedNames.add(name)
  const responseSource = facts.receivedHeaders ?? facts.responseHeaders
  const response = responseSource ? redactHeaders(responseSource, secrets) : null
  for (const name of response?.redacted ?? []) redactedNames.add(name)
  const detail: RequestDetail = {
    ...record,
    ...(view.redirectedTo !== undefined ? { redirectedTo: view.redirectedTo } : {}),
    ...(view.mimeType !== undefined ? { mimeType: view.mimeType } : {}),
    ...(facts.protocol !== undefined ? { protocol: facts.protocol } : {}),
    ...(facts.remoteAddress !== undefined ? { remoteAddress: facts.remoteAddress } : {}),
    requestHeaders: request.headers,
    requestHeadersAre: facts.sentHeaders ? SENT : ISSUED,
    sizes: {
      ...(facts.encodedBytes !== undefined ? { transferredBytes: facts.encodedBytes } : {}),
      ...(facts.bodyBytes !== undefined ? { bodyBytes: facts.bodyBytes } : {}),
    },
  }
  if (requestBody instanceof Buffer) {
    const { text, base64Encoded } = bodyOf(requestBody)
    detail.requestBody = text
    if (base64Encoded) detail.requestBodyBase64Encoded = true
  } else if (requestBody !== null && 'unavailable' in requestBody) {
    detail.requestBodyNote = `Chrome said the request had a body but did not give it: ${requestBody.unavailable}`
  }
  if (response) {
    detail.responseHeaders = response.headers
    detail.responseHeadersAre = facts.receivedHeaders ? RECEIVED : PARSED
  }
  const failure = facts.failure
  if (failure) {
    detail.failureText = failure.errorText
    if (failure.canceled) detail.canceled = true
    if (failure.blockedReason !== undefined) detail.blockedReason = failure.blockedReason
    if (failure.cors !== undefined) detail.cors = failure.cors
    if (record.failed === undefined && record.status !== undefined && record.status >= 400) {
      detail.note = `The server answered ${record.status}${record.statusText ? ` ${record.statusText}` : ''}; Chrome then stopped reading the body of that error response (${failure.errorText}${failure.canceled ? ', canceled' : ''}), as it does for a script or stylesheet that answers with an error status. The request did not fail on the network.`
    }
  }
  if ('unavailable' in body) {
    detail.noBody = body.unavailable
  } else {
    detail.body = body.body
    detail.truncated = body.truncated
    detail.base64Encoded = body.base64Encoded
  }
  if (redactedNames.size > 0) {
    detail.redacted = `${[...redactedNames].join(', ')} ${redactedNames.size === 1 ? 'is' : 'are'} shown as <redacted, N chars>; net.request('${record.id}', { secrets: true }) shows the values.`
  }
  return detail
}

// ---------------------------------------------------------------------------
// HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/)
// ---------------------------------------------------------------------------

interface HarNameValue {
  name: string
  value: string
}

/** One entry's response body for the HAR, or why it is not in it. */
export type HarBody = { bytes: Buffer } | { unavailable: string } | null

function harHeaders(headers: Protocol.Network.Headers | undefined, secrets: boolean): HarNameValue[] {
  if (!headers) return []
  const out: HarNameValue[] = []
  for (const [name, value] of Object.entries(redactHeaders(headers, secrets).headers)) {
    // Chrome joins repeated headers (Set-Cookie) with a newline: one HAR row each.
    for (const line of value.split('\n')) out.push({ name, value: line })
  }
  return out
}

function harCookies(headers: Protocol.Network.Headers | undefined, name: 'cookie' | 'set-cookie', secrets: boolean): HarNameValue[] {
  const value = headerValue(headers, name)
  if (!secrets || value === undefined) return []
  const pairs = name === 'cookie' ? value.split(';') : value.split('\n').map((line) => line.split(';', 1)[0]!)
  return pairs
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => {
      const at = pair.indexOf('=')
      return at === -1 ? { name: pair, value: '' } : { name: pair.slice(0, at), value: pair.slice(at + 1) }
    })
}

function queryString(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

/** HAR timings from Chrome's ResourceTiming (ms offsets from `requestTime`) and the hop's end. */
function harTimings(facts: RequestFacts, totalMs: number | undefined): { blocked: number; dns: number; connect: number; ssl: number; send: number; wait: number; receive: number; comment?: string } {
  const t = facts.timing
  if (!t) {
    return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: totalMs ?? 0, receive: 0, comment: 'Chrome reported no timing breakdown for this request (served from a cache, or it failed before a connection); wait is the whole duration.' }
  }
  const span = (start: number, end: number): number => (start >= 0 && end >= start ? end - start : -1)
  const firstActivity = [t.dnsStart, t.connectStart, t.sendStart].find((value) => value >= 0) ?? 0
  const dns = span(t.dnsStart, t.dnsEnd)
  const connect = span(t.connectStart, t.connectEnd)
  const ssl = span(t.sslStart, t.sslEnd)
  const send = Math.max(0, t.sendEnd - t.sendStart)
  const wait = Math.max(0, t.receiveHeadersEnd - t.sendEnd)
  const end = facts.endedTs !== undefined ? (facts.endedTs - t.requestTime) * 1000 : t.receiveHeadersEnd
  const receive = Math.max(0, end - t.receiveHeadersEnd)
  return { blocked: firstActivity, dns, connect, ssl, send, wait, receive }
}

export interface Har {
  log: {
    version: '1.2'
    creator: { name: string; version: string }
    pages: Array<{ startedDateTime: string; id: string; title: string; pageTimings: Record<string, never>; comment?: string }>
    entries: unknown[]
    comment: string
  }
}

/** The journal's hops as a HAR 1.2 log. `bodies` maps a hop id to its response body (or why it is missing). */
export function buildHar({
  views,
  bodies,
  requestBodies,
  pageUrl,
  secrets,
  version,
}: {
  views: RequestView[]
  bodies: Map<string, HarBody>
  requestBodies: Map<string, Buffer>
  pageUrl: string
  secrets: boolean
  version: string
}): Har {
  const pageId = 'page_1'
  const started = views.length > 0 ? Math.min(...views.map((view) => view.record.startedAt)) : Date.now()
  const redactedNote = secrets
    ? 'Credential headers are included as sent and received.'
    : 'Credential headers (Cookie, Set-Cookie, Authorization, Proxy-Authorization) are shown as <redacted, N chars> and their cookies are left out; net.har({ path, secrets: true }) includes them.'
  const entries = views.map((view) => {
    const { record, facts } = view
    const totalMs = record.durationMs
    const timings = harTimings(facts, totalMs)
    const time = [timings.blocked, timings.dns, timings.connect, timings.send, timings.wait, timings.receive].filter((value) => value > 0).reduce((sum, value) => sum + value, 0)
    const requestHeaders = facts.sentHeaders ?? facts.requestHeaders
    const responseHeaders = facts.receivedHeaders ?? facts.responseHeaders
    const postData = requestBodies.get(record.id)
    const body = bodies.get(record.id) ?? null
    const mimeType = view.mimeType ?? headerValue(responseHeaders, 'content-type') ?? ''
    let content: Record<string, unknown> = { size: facts.bodyBytes ?? -1, mimeType }
    if (body && 'bytes' in body) {
      const textual = isTextualMime(mimeType)
      content = textual ? { size: body.bytes.length, mimeType, text: body.bytes.toString('utf8') } : { size: body.bytes.length, mimeType, text: body.bytes.toString('base64'), encoding: 'base64' }
    } else if (body && 'unavailable' in body) {
      content.comment = `No body: ${body.unavailable}`
    }
    const responded = record.status !== undefined
    return {
      pageref: pageId,
      startedDateTime: new Date(record.startedAt).toISOString(),
      time,
      request: {
        method: record.method,
        url: record.url,
        httpVersion: facts.protocol ?? '',
        cookies: harCookies(requestHeaders, 'cookie', secrets),
        headers: harHeaders(requestHeaders, secrets),
        queryString: queryString(record.url),
        ...(postData !== undefined
          ? {
              postData: {
                mimeType: headerValue(requestHeaders, 'content-type') ?? '',
                ...(bodyOf(postData).base64Encoded ? { text: postData.toString('base64'), comment: 'base64: the request body is not UTF-8 text' } : { text: postData.toString('utf8') }),
              },
            }
          : {}),
        headersSize: -1,
        bodySize: postData?.length ?? (facts.hasPostData ? -1 : 0),
      },
      response: {
        status: record.status ?? 0,
        statusText: facts.statusText ?? '',
        httpVersion: facts.protocol ?? '',
        cookies: harCookies(responseHeaders, 'set-cookie', secrets),
        headers: harHeaders(responseHeaders, secrets),
        content,
        redirectURL: view.redirectedToUrl ?? headerValue(responseHeaders, 'location') ?? '',
        headersSize: -1,
        // The body's size on the wire is not reported apart from the headers' (_transferSize has both).
        bodySize: responded ? -1 : 0,
        ...(responded ? {} : { comment: record.failed !== undefined ? `No response: ${record.failed}` : record.lost !== undefined ? `No response: ${record.lost}` : record.endedAt === undefined ? 'No response yet: the request was still open when the HAR was written.' : 'No response' }),
      },
      cache: {},
      timings,
      ...(facts.remoteAddress !== undefined ? { serverIPAddress: facts.remoteAddress.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') } : {}),
      _id: record.id,
      ...(record.resourceType !== undefined ? { _resourceType: record.resourceType } : {}),
      ...(facts.encodedBytes !== undefined ? { _transferSize: facts.encodedBytes } : {}),
      ...(record.failed !== undefined ? { _failure: record.failed } : {}),
      ...(facts.failure?.cors !== undefined ? { _corsError: facts.failure.cors } : {}),
      ...(record.lost !== undefined ? { _lost: record.lost } : {}),
      ...(record.download !== undefined ? { _download: record.download } : {}),
      ...(record.worker !== undefined ? { _worker: record.worker } : {}),
      ...(record.frame !== undefined ? { _frame: record.frame } : {}),
      ...(record.fromCache ? { _fromCache: true } : {}),
    }
  })
  return {
    log: {
      version: '1.2',
      creator: { name: 'playwriter', version },
      // Titled by its address, as Chrome DevTools titles the pages of the HAR files it exports (the title would take a script run in the page).
      pages: [{ startedDateTime: new Date(started).toISOString(), id: pageId, title: pageUrl, pageTimings: {} }],
      entries,
      comment: `Written from the request journal playwriter keeps for this page (the last requests Chrome reported; nothing was requested again). ${redactedNote}`,
    },
  }
}

// ---------------------------------------------------------------------------
// The sandbox calls
// ---------------------------------------------------------------------------

/** What `net.request` and `net.har` read from a page's journal (PageWatch). */
export interface JournalSource {
  requestView(id: string): RequestView
  requestViews(filter?: { urlIncludes?: string }): RequestView[]
  requestBody(id: string): Promise<Buffer | { unavailable: string } | null>
  responseBody(id: string): Promise<{ status?: number; mimeType?: string; body: string; truncated: boolean; base64Encoded: boolean }>
  responseBytes(id: string): Promise<{ bytes: Buffer }>
}

/** Why `read` has no answer, or its answer. A frozen page (a dialog) is not an answer: it is thrown. */
async function orUnavailable<T>(read: Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await read
  } catch (error) {
    if (error instanceof PageUnresponsiveError) throw error
    return { unavailable: error instanceof Error ? error.message : String(error) }
  }
}

/** `net.request(id, { secrets })`: everything Chrome reported about request `id`, with its response body when Chrome still holds one. */
export async function requestDetail(journal: JournalSource, id: string, { secrets }: { secrets: boolean }): Promise<RequestDetail> {
  if (typeof id !== 'string') {
    throw new ModelFacingError("net.request(id) takes a request id from net.requests() or the report as a string, like net.request('r12').")
  }
  const view = journal.requestView(id)
  const [body, requestBody] = await Promise.all([orUnavailable(journal.responseBody(id)), journal.requestBody(id)])
  return describeRequest({ view, body, requestBody, secrets })
}

/**
 * `net.har({ path })`: the journal's requests written to `target` as HAR 1.2, with the response bodies
 * Chrome still holds (`bodies: false` leaves them out). Nothing is requested again.
 */
export async function writeHar({
  journal,
  target,
  pageUrl,
  secrets,
  bodies,
  urlIncludes,
}: {
  journal: JournalSource
  target: string
  pageUrl: string
  secrets: boolean
  bodies: boolean
  urlIncludes?: string
}): Promise<{ path: string; entries: number; bodies: number; bodiesMissing: Array<{ id: string; url: string; why: string }>; note: string }> {
  const views = journal.requestViews(urlIncludes === undefined ? {} : { urlIncludes })
  const bodyById = new Map<string, HarBody>()
  const requestBodies = new Map<string, Buffer>()
  const missing: Array<{ id: string; url: string; why: string }> = []
  for (const view of views) {
    const { id, url } = view.record
    const requestBody = await journal.requestBody(id)
    if (requestBody instanceof Buffer) requestBodies.set(id, requestBody)
    // A redirect and a download have no body for the page by nature; a request with no response has none either.
    if (!bodies || view.record.status === undefined || view.redirectedTo !== undefined || view.record.download !== undefined) continue
    const read = await orUnavailable(journal.responseBytes(id))
    if ('unavailable' in read) {
      bodyById.set(id, read)
      missing.push({ id, url, why: read.unavailable })
    } else {
      bodyById.set(id, { bytes: read.bytes })
    }
  }
  const har = buildHar({ views, bodies: bodyById, requestBodies, pageUrl, secrets, version: VERSION })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(har, null, 2))
  const note = secrets
    ? 'Credential headers are included.'
    : 'Credential headers (Cookie, Set-Cookie, Authorization, Proxy-Authorization) are written as <redacted, N chars>; net.har({ path, secrets: true }) includes them.'
  return {
    path: target,
    entries: views.length,
    bodies: bodyById.size - missing.length,
    bodiesMissing: missing,
    note: bodies ? note : `${note} Response bodies were left out (bodies: false).`,
  }
}
