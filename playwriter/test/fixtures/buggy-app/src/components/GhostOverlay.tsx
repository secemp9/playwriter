import { useState } from 'react'

// BUG (f): a full-screen invisible overlay (opacity 0, pointer-events auto) is
// always rendered in the DOM, positioned fixed at top of the stacking context.
// It never goes away, so every click on the page — the toggle buttons, any
// interactive element outside this section — is swallowed. The user can toggle
// the overlay "on" and "off" in the UI, but the DOM element is always mounted.

export function GhostOverlay() {
  const [overlayVisible, setOverlayVisible] = useState(false)

  return (
    <section style={{ position: 'relative' }}>
      <h2>Ghost Overlay</h2>
      <p>
        Overlay is <strong>{overlayVisible ? 'ON' : 'OFF'}</strong>
      </p>
      <button
        data-testid="toggle-overlay"
        onClick={() => setOverlayVisible((v) => !v)}
      >
        {overlayVisible ? 'Hide Overlay' : 'Show Overlay'}
      </button>

      <p style={{ marginTop: 16, marginBottom: 4, fontSize: 13, color: '#888' }}>
        Buttons below test whether clicks are being blocked:
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button data-testid="click-target-a" onClick={() => alert('A clicked')}>
          Click target A
        </button>
        <button data-testid="click-target-b" onClick={() => alert('B clicked')}>
          Click target B
        </button>
      </div>

      {/* The ghost: always mounted, only visually hidden. */}
      <div
        data-testid="ghost-overlay"
        style={{
          position: 'fixed',
          inset: 0,
          opacity: overlayVisible ? 0.3 : 0,
          background: overlayVisible ? '#f00' : 'transparent',
          pointerEvents: 'auto',
          zIndex: 9999,
        }}
      />
    </section>
  )
}
