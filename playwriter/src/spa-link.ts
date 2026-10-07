/**
 * Which of the page's own links act.spaNavigate clicks for a route. Apps carry state in their
 * links' query strings (`/spa/products?tag=…`, `?ref=nav`), so a route given as a path matches a
 * link by its path, ignoring the query unless the route has one, and by its #fragment only when
 * the route has one. A link to exactly the given address wins; links to different addresses that
 * all match are an ambiguity the model resolves, never a guess.
 */

/** A link from the observation taken right before the action. */
export interface SpaLink {
  ref: number
  name: string
  /** As observe() read it: absolute, or relative to the page. */
  href: string
  /** In view now (a person clicks what they see before scrolling to another copy). */
  inView: boolean
}

export type SpaLinkMatch =
  | { kind: 'link'; link: SpaLink; exact: boolean }
  | { kind: 'ambiguous'; links: SpaLink[] }
  | { kind: 'none' }

/** `url` as a model writes a route: path, query, #fragment. */
export function routeOf(url: URL): string {
  return `${url.pathname}${url.search}${url.hash}`
}

/** One link per distinct address, the first in view else the first in page order. */
function onePerAddress(links: SpaLink[], base: URL): SpaLink[] {
  const byAddress = new Map<string, SpaLink>()
  for (const link of links) {
    const address = new URL(link.href, base).href
    const kept = byAddress.get(address)
    if (!kept || (!kept.inView && link.inView)) byAddress.set(address, link)
  }
  return [...byAddress.values()]
}

/** The link to click for route `argument` (a path or a same-site URL), read against the page URL `base`. */
export function matchSpaLink(argument: string, base: URL, links: SpaLink[]): SpaLinkMatch {
  const target = new URL(argument, base)
  const beforeHash = argument.split('#')[0]
  const givenQuery = beforeHash.includes('?')
  const givenHash = argument.includes('#')
  const exact = onePerAddress(
    links.filter((link) => new URL(link.href, base).href === target.href),
    base,
  )
  if (exact.length === 1) return { kind: 'link', link: exact[0], exact: true }
  const loose = onePerAddress(
    links.filter((link) => {
      const url = new URL(link.href, base)
      return (
        url.origin === target.origin &&
        url.pathname === target.pathname &&
        (!givenQuery || url.search === target.search) &&
        (!givenHash || url.hash === target.hash)
      )
    }),
    base,
  )
  if (loose.length === 0) return { kind: 'none' }
  if (loose.length === 1) return { kind: 'link', link: loose[0], exact: false }
  return { kind: 'ambiguous', links: loose }
}
