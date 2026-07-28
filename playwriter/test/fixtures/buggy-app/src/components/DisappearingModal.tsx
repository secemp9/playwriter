import { useState, useEffect, useRef } from 'react'

// BUG (e): clicking the modal's "close" action does close it — but so does
// clicking ANYWHERE inside the modal body, because the backdrop click handler
// fires on bubbled clicks too (the event target check is inverted). The modal
// also auto-closes after 3 seconds via a timer whose cleanup is intentionally
// broken, so reopening the modal before the timer fires creates two timers.

export function DisappearingModal() {
  const [open, setOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Auto-close after 3 s. The timer is NOT properly cleared on unmount or when
  // open toggles again, so a second open queues a second close.
  useEffect(() => {
    if (open) {
      timerRef.current = setTimeout(() => {
        setOpen(false)
      }, 3000)
    }
    // Intentionally missing cleanup — timer leaks and fires on stale open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function handleBackdropClick(e: React.MouseEvent) {
    // The check is INVERTED: it fires when the click DID originate from the
    // body, not when it came from the backdrop. Every click inside the modal
    // body also appears as a bubble on the backdrop div, so this always closes.
    if (bodyRef.current && bodyRef.current.contains(e.target as Node)) {
      setOpen(false)
    }
  }

  return (
    <section>
      <h2>Settings Modal</h2>
      <button data-testid="open-settings" onClick={() => setOpen(true)}>
        Open Settings
      </button>

      {open && (
        <div
          data-testid="modal-backdrop"
          onClick={handleBackdropClick}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            ref={bodyRef}
            data-testid="modal-body"
            style={{
              background: '#fff',
              padding: 24,
              borderRadius: 8,
              minWidth: 280,
              border: '1px solid #ccc',
            }}
          >
            <h3 style={{ marginTop: 0 }}>Settings</h3>
            <p>Some configuration options go here.</p>
            <button
              data-testid="modal-close"
              onClick={() => setOpen(false)}
              style={{ marginRight: 8 }}
            >
              Close
            </button>
            <span style={{ fontSize: 12, color: '#888' }}>
              (modal auto-closes in 3 s)
            </span>
          </div>
        </div>
      )}
    </section>
  )
}
