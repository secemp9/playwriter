// Date formatting helper, deliberately in its OWN module so a trace must hop
// cross-module (and interprocedurally) from the rendering component into here.
//
// BUG (b): formatDate assumes the input is a `DD/MM/YYYY` string and rebuilds
// it as `YYYY-MM-DD`. The mock API actually returns ISO 8601 timestamps
// (e.g. "2026-07-24T09:11:02Z"), so `s.split('/')` returns a single-element
// array -> d/m/y become garbage -> `new Date("undefined-undefined-...")` is
// Invalid Date -> toLocaleDateString() yields the literal "Invalid Date".

export function formatDate(s: string): string {
  const [d, m, y] = s.split('/')
  const rebuilt = `${y}-${m}-${d}`
  return new Date(rebuilt).toLocaleDateString()
}

// Kept alongside so callers can see the intended (DD/MM/YYYY) contract.
export function isProbablyDdMmYyyy(s: string): boolean {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(s)
}
