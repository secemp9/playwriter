import { useState } from 'react'
import { CartTotal } from './components/CartTotal'
import { OrderRow } from './components/OrderRow'
import { SearchList } from './components/SearchList'
import { NotificationBadge } from './components/NotificationBadge'
import { DisappearingModal } from './components/DisappearingModal'
import { GhostOverlay } from './components/GhostOverlay'
import { StaleCounter } from './components/StaleCounter'
import { RaceConditionForm } from './components/RaceConditionForm'
import { LayoutShift } from './components/LayoutShift'

type Tab = 'cart' | 'orders' | 'search' | 'notifications' | 'modal' | 'overlay' | 'counter' | 'form' | 'layout'

const TABS: { id: Tab; label: string; testid: string }[] = [
  { id: 'cart', label: 'Cart (bug a)', testid: 'tab-cart' },
  { id: 'orders', label: 'Orders (bug b)', testid: 'tab-orders' },
  { id: 'search', label: 'Search (bug c)', testid: 'tab-search' },
  { id: 'notifications', label: 'Notifications (bug d)', testid: 'tab-notifications' },
  { id: 'modal', label: 'Modal (bug e)', testid: 'tab-modal' },
  { id: 'overlay', label: 'Overlay (bug f)', testid: 'tab-overlay' },
  { id: 'counter', label: 'Counter (bug g)', testid: 'tab-counter' },
  { id: 'form', label: 'Form (bug h)', testid: 'tab-form' },
  { id: 'layout', label: 'Layout (bug i)', testid: 'tab-layout' },
]

export function App() {
  const [tab, setTab] = useState<Tab>('cart')

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto' }}>
      <h1>Buggy App Fixture</h1>
      <nav style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            data-testid={t.testid}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{ fontWeight: tab === t.id ? 700 : 400 }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'cart' && <CartTotal />}
      {tab === 'orders' && <OrderRow />}
      {tab === 'search' && <SearchList />}
      {tab === 'notifications' && <NotificationBadge />}
      {tab === 'modal' && <DisappearingModal />}
      {tab === 'overlay' && <GhostOverlay />}
      {tab === 'counter' && <StaleCounter />}
      {tab === 'form' && <RaceConditionForm />}
      {tab === 'layout' && <LayoutShift />}
    </main>
  )
}
