import { useState, useEffect } from 'react'

// BUG (g): the counter stores its value in localStorage and reads it back on
// mount. But the effect uses an empty dependency array, so it only reads once
// (the initial render, before the stored value is loaded). The later render
// with the loaded value is never reflected because the effect never re-runs.
// Furthermore, the write-back effect depends on `count` but the setter itself
// has a stale closure that resets to the initial stored value.

const STORAGE_KEY = 'stale-counter-value'

export function StaleCounter() {
  const [count, setCount] = useState(0)
  const [initialized, setInitialized] = useState(false)

  // Load persisted value once on mount. Because the component renders with
  // count=0 first, then this effect fires async and runs setCount(stored), the
  // display shows 0 for a frame — but that's not the main bug.
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) {
      setCount(Number(stored))
    }
    setInitialized(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist every time count changes. This one IS correct (it has [count]).
  useEffect(() => {
    if (initialized) {
      localStorage.setItem(STORAGE_KEY, String(count))
    }
  }, [count, initialized])

  // BUG: the increment handler has a stale closure over `count`.
  // The fix would be setCount(c => c + 1), but the closure captures
  // the render-time `count`, so incrementing twice quickly adds only 1.
  function handleIncrement() {
    setCount(count + 1)
  }

  function handleReset() {
    setCount(0)
    localStorage.removeItem(STORAGE_KEY)
  }

  return (
    <section>
      <h2>Stale Counter</h2>
      <p>
        Count: <strong data-testid="counter-value">{count}</strong>
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button data-testid="counter-inc" onClick={handleIncrement}>
          +1
        </button>
        <button data-testid="counter-reset" onClick={handleReset}>
          Reset
        </button>
      </div>
      <p style={{ fontSize: 12, color: '#888', marginTop: 12 }}>
        Stored value in localStorage persists across re-renders. Reload the page
        to see the stale-initialization bug.
      </p>
    </section>
  )
}
