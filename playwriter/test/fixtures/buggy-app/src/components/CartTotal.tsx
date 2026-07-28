import { useSyncExternalStore } from 'react'
import { store, type CartState } from '../store/cartStore'

// The catalogue the "Add item" button pulls from.
const CATALOGUE = [
  { id: 'sku-1', name: 'Coffee Mug', price: 12.5 },
  { id: 'sku-2', name: 'T-Shirt', price: 24.0 },
  { id: 'sku-3', name: 'Sticker Pack', price: 4.75 },
]

// Reference-equality snapshot: getSnapshot returns the WHOLE state object.
// React's useSyncExternalStore compares snapshots with Object.is. Because the
// reducer mutates and returns the SAME reference on ADD_ITEM, the "new"
// snapshot is === the previous one, so React bails out of re-rendering and the
// displayed total stays STALE even though state.total has actually changed.
function useCartState(): CartState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

export function CartTotal() {
  const state = useCartState()
  const nextItem = CATALOGUE[state.items.length % CATALOGUE.length]

  return (
    <section>
      <h2>Cart</h2>
      <p>
        Items in cart: <strong>{state.items.length}</strong>
      </p>
      <p>
        Total:{' '}
        <span data-testid="cart-total">${state.total.toFixed(2)}</span>
      </p>
      <button
        data-testid="add-item"
        onClick={() => store.dispatch({ type: 'ADD_ITEM', item: nextItem })}
      >
        Add {nextItem.name} (${nextItem.price.toFixed(2)})
      </button>
      <button
        data-testid="reset-cart"
        onClick={() => store.dispatch({ type: 'RESET' })}
      >
        Reset
      </button>
      <p style={{ color: '#888', fontSize: 12 }}>
        Expected total after adds: watch it go stale.
      </p>
    </section>
  )
}
