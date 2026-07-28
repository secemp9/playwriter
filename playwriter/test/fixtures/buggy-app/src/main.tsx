import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
// Importing the store here guarantees window.__STORE__ is set up on boot,
// so a storeIdentity probe can read it regardless of which tab is active.
import './store/cartStore'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root not found')

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
