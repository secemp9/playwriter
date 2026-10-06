// Fixture for src/element-explain-live.test.ts: a real React 19 app (bundled by
// build.ts with a linked sourcemap) whose handlers explain() must find, locate in THIS
// file through the sourcemap, and summarise. Line numbers matter to the test only via
// the names below, never via hard-coded numbers.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

function SendButton({ onSend, disabled }: { onSend: () => void; disabled: boolean }) {
  return (
    <button className="send" type="submit" disabled={disabled} onClick={onSend}>
      Send
    </button>
  )
}

function ChatComposer() {
  const [draft, setDraft] = useState('hello')
  const [sending, setSending] = useState(false)

  async function handleSend() {
    setSending(true)
    await fetch(`/api/messages`, { method: 'POST', body: JSON.stringify({ text: draft }) })
    setDraft('')
    setSending(false)
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        void handleSend()
      }}
    >
      <input aria-label="Message" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <SendButton onSend={handleSend} disabled={sending} />
    </form>
  )
}

function ChatPanel() {
  return (
    <section className="panel">
      <ChatComposer />
    </section>
  )
}

function App() {
  return (
    <main>
      <ChatPanel />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
