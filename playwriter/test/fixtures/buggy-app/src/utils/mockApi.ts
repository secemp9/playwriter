// Mock search endpoint with a VARIABLE, inverted delay: shorter queries take
// LONGER to resolve. This makes the race in <SearchList> deterministic — the
// earlier request for the short query "re" resolves AFTER the later request for
// the longer query "reac", so a naive last-write-wins effect ends up showing
// results for the stale query.

export interface SearchResult {
  id: string
  label: string
}

const CORPUS = [
  'react',
  'react-dom',
  'react-router',
  'redux',
  'redis-client',
  'realm',
  'recoil',
  'remix',
  'preact',
  'svelte',
  'vue',
  'angular',
]

export function searchApi(query: string): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase()
  // Inverted delay: the shorter the query, the slower it resolves.
  // len 2 -> ~300ms, len 4 -> ~60ms, so an earlier short-query request lands
  // after a later long-query request.
  const delay = Math.max(20, 360 - q.length * 80)

  return new Promise((resolve) => {
    setTimeout(() => {
      if (!q) {
        resolve([])
        return
      }
      const results = CORPUS.filter((c) => c.includes(q)).map((label, i) => ({
        id: `${q}-${i}`,
        label,
      }))
      resolve(results)
    }, delay)
  })
}
