/**
 * allowed-domains.ts — `browser({ action: 'new', allowedDomains })`: the new browser contacts only the
 * listed hosts.
 *
 * Every request is held at the browser target (CDP Fetch on the browser session, which measured: holds
 * the requests of pages, iframes, dedicated, shared and service workers alike) and let through when its
 * host is allowed; any other is failed with `BlockedByClient`. The page sees what it sees when an ad
 * blocker refuses a request (`net::ERR_BLOCKED_BY_CLIENT`), and nothing is added to it. The report
 * names the cause: `blockedByAllowedDomains(requestId)` gives the text for a request this process
 * blocked (Fetch's `networkId` is the request's Network.requestId).
 *
 * Not held by Fetch, so not blocked by this: WebSocket connections and WebRTC (they do not go through
 * the HTTP request pipeline Fetch intercepts) — see the measured limits in the docs.
 */

import type { Browser, CDPSession } from '@xmorse/playwright-core'
import type { Protocol } from 'devtools-protocol'
import { ModelFacingError } from './probe-types.js'
import { withDeadline } from './isolated-world.js'

/** One allowed entry: `example.com` (that host and its subdomains) or `*.example.com` (subdomains only). */
export interface AllowedDomain {
  host: string
  subdomainsOnly: boolean
}

const HOST_PATTERN = /^(\*\.)?([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/

/** Parse the model's list; refuses an entry that is not a host name (a URL, a port, a path). */
export function parseAllowedDomains(entries: string[]): AllowedDomain[] {
  return entries.map((entry) => {
    const normalized = entry.trim().toLowerCase().replace(/\.$/, '')
    const match = HOST_PATTERN.exec(normalized)
    if (!match) {
      throw new ModelFacingError(
        `allowedDomains: ${JSON.stringify(entry)} is not a host name. Write hosts only, without scheme, port or path: "example.com" (it and its subdomains), "*.example.com" (subdomains only), "127.0.0.1".`,
      )
    }
    return { host: match[2]!, subdomainsOnly: match[1] !== undefined }
  })
}

export function describeAllowedDomains(domains: AllowedDomain[]): string {
  return domains.map((domain) => (domain.subdomainsOnly ? `*.${domain.host}` : domain.host)).join(', ')
}

export function isHostAllowed(hostname: string, domains: AllowedDomain[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return domains.some((domain) => (host.endsWith(`.${domain.host}`) ? true : !domain.subdomainsOnly && host === domain.host))
}

/** Why each blocked request failed, by Network.requestId; read by the report (network-detail.ts). */
const blocked = new Map<string, string>()

/** The report's text for a request this process blocked because of allowedDomains, else undefined. */
export function blockedByAllowedDomains(requestId: string): string | undefined {
  return blocked.get(requestId)
}

/** Schemes Fetch reports that never reach a host (served by Chrome itself). */
const LOCAL_SCHEMES: Record<string, true> = { 'data:': true, 'blob:': true, 'about:': true, 'chrome:': true, 'chrome-extension:': true, 'devtools:': true }

const SEND_DEADLINE_MS = 10_000

/**
 * Hold every request of `browser` and fail those to hosts outside `domains`, for the browser's life.
 * Returns the browser session that holds them. `logger.error` gets requests that could not be
 * answered (their target went away).
 */
export async function enforceAllowedDomains({
  browser,
  domains,
  logger,
}: {
  browser: Browser
  domains: AllowedDomain[]
  logger: { error(...args: unknown[]): void }
}): Promise<CDPSession> {
  const session = await withDeadline(browser.newBrowserCDPSession(), SEND_DEADLINE_MS, 'opening the browser session for allowedDomains')
  const allowedText = describeAllowedDomains(domains)
  session.on('Fetch.requestPaused', (event: Protocol.Fetch.RequestPausedEvent) => {
    const url = new URL(event.request.url)
    const allowed = LOCAL_SCHEMES[url.protocol] === true || isHostAllowed(url.hostname, domains)
    if (!allowed && event.networkId) {
      blocked.set(event.networkId, `blocked: ${url.hostname} is not in allowedDomains (${allowedText})`)
    }
    const answer = allowed
      ? session.send('Fetch.continueRequest', { requestId: event.requestId })
      : session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
    withDeadline(answer, SEND_DEADLINE_MS, `answering the held request for ${event.request.url}`).catch((error: unknown) => {
      // The page cancelled the request, or left the document, while it was held: nothing to answer.
      if (error instanceof Error && error.message.includes('Invalid InterceptionId')) return
      logger.error(`allowedDomains: the held request for ${event.request.url} could not be ${allowed ? 'continued' : 'failed'}:`, error)
    })
  })
  await withDeadline(session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }), SEND_DEADLINE_MS, 'Fetch.enable on the browser session')
  return session
}
