import { useEffect, useState } from 'react'
import { searchApi, type SearchResult } from '../utils/mockApi'

// BUG (c): the effect fires one searchApi call per keystroke, keyed on `query`,
// with NO abort controller and NO sequence/latest-request guard. Because the
// mock API resolves shorter queries more slowly, an earlier request can resolve
// AFTER a newer one and overwrite it (last-write-wins). The list then shows
// results for a stale query — and intermittently appears empty/wrong.
export function SearchList() {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!query) {
      setItems([]) // writer #1
      return
    }
    setLoading(true)
    // No AbortController, no request-id check: whatever resolves last wins.
    searchApi(query).then((results) => {
      setItems(results) // writer #2 — may be a stale, out-of-order response
      setLoading(false)
    })
  }, [query])

  return (
    <section>
      <h2>Search</h2>
      <input
        data-testid="search-input"
        placeholder="Type a library name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {loading && <span data-testid="search-loading"> loading…</span>}
      <ul data-testid="search-list">
        {items.map((it) => (
          <li key={it.id}>{it.label}</li>
        ))}
      </ul>
    </section>
  )
}
