import { useState, useEffect, useRef } from 'react'

// BUG (h): the auto-save effect has no cleanup. Every time formData changes, a
// new 2-second timer is queued. Each timer captures the formData value from the
// render that created it. By the time the timer fires (2 s later), the user has
// likely typed more, so the data SENT to performSave is stale. This is a
// classic stale closure in async callbacks.

interface FormState {
  name: string
  email: string
  message: string
}

interface SaveResponse {
  saved: FormState
  timestamp: string
}

// Simulated API: returns whatever was sent after a delay.
function performSave(data: FormState): Promise<SaveResponse> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ saved: data, timestamp: new Date().toISOString() })
    }, 2000)
  })
}

export function RaceConditionForm() {
  const [formData, setFormData] = useState<FormState>({
    name: '',
    email: '',
    message: '',
  })
  const [lastSaved, setLastSaved] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveCount, setSaveCount] = useState(0)
  const saveVersion = useRef(0)

  // Auto-save effect: runs on every formData change after a 2-second delay.
  // Intentionally NO cleanup — old timers are never cancelled, so they pile up
  // and each one sends stale data from the render that created it.
  useEffect(() => {
    if (!formData.name && !formData.email && !formData.message) return

    setSaving(true)
    const version = ++saveVersion.current

    const timer = setTimeout(async () => {
      // `formData` here is the value from the render that QUEUED this timer,
      // which is stale if the user typed more since then.
      const response = await performSave(formData)

      // Only update UI if this is still the latest save version.
      // (This guard is correct, but the DATA sent to performSave is already stale.)
      if (version === saveVersion.current) {
        setLastSaved(response.saved)
        setSaveCount((c) => c + 1)
        setSaving(false)
      }
    }, 2000)

    // BUG: no return () => clearTimeout(timer) — old timeouts are NOT cancelled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    ;void timer
  }, [formData])

  function handleChange(field: keyof FormState, value: string) {
    setFormData((prev) => ({ ...prev, [field]: value }))
  }

  return (
    <section>
      <h2>Auto-Save Form</h2>
      <p style={{ fontSize: 13, color: '#888' }}>
        Type in any field — auto-save fires after 2 seconds of inactivity, but
        it sends STALE data due to uncancelled timeouts stacking up.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 360 }}>
        <input
          data-testid="form-name"
          placeholder="Name"
          value={formData.name}
          onChange={(e) => handleChange('name', e.target.value)}
        />
        <input
          data-testid="form-email"
          placeholder="Email"
          value={formData.email}
          onChange={(e) => handleChange('email', e.target.value)}
        />
        <textarea
          data-testid="form-message"
          placeholder="Message"
          value={formData.message}
          onChange={(e) => handleChange('message', e.target.value)}
          rows={3}
        />
      </div>

      <p>
        Status:{' '}
        <span data-testid="form-status">
          {saving ? 'Saving...' : lastSaved ? 'Saved' : 'Idle'}
        </span>
        {saveCount > 0 && (
          <span style={{ fontSize: 12, color: '#888', marginLeft: 8 }}>
            (saved {saveCount} time{saveCount !== 1 ? 's' : ''})
          </span>
        )}
      </p>

      {lastSaved && (
        <div
          data-testid="last-saved"
          style={{
            fontSize: 12,
            background: '#f5f5f5',
            padding: 8,
            borderRadius: 4,
            maxWidth: 360,
          }}
        >
          <strong>Last saved data:</strong>
          <pre style={{ margin: 4, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(lastSaved, null, 2)}
          </pre>
        </div>
      )}
    </section>
  )
}
