// Minimal hand-rolled redux-ish store (avoids pulling the `redux` dependency).
// Exposed on window.__STORE__ so a `storeIdentity` probe can read getState().
//
// BUG (a): the reducer MUTATES the existing state on ADD_ITEM and returns the
// SAME object reference. Reference-equality selectors therefore never observe a
// change, so <CartTotal> renders a STALE total after an item is added.

export interface CartItem {
  id: string
  name: string
  price: number
}

export interface CartState {
  items: CartItem[]
  total: number
}

export type CartAction =
  | { type: 'ADD_ITEM'; item: CartItem }
  | { type: 'RESET' }

type Listener = () => void

export interface Store<S, A> {
  getState(): S
  dispatch(action: A): void
  subscribe(listener: Listener): () => void
}

const initialState: CartState = {
  items: [],
  total: 0,
}

// `state` is declared `const` in the signature and *looks* constant, yet the
// ADD_ITEM branch pushes into state.items and increments state.total in place,
// then returns the very same reference it received.
function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'ADD_ITEM': {
      // --- the culprit: in-place mutation + same-reference return ---
      state.items.push(action.item)
      state.total += action.item.price
      return state
    }
    case 'RESET': {
      return { items: [], total: 0 }
    }
    default:
      return state
  }
}

function createStore<S, A>(
  reducer: (state: S, action: A) => S,
  preloaded: S,
): Store<S, A> {
  let currentState = preloaded
  const listeners = new Set<Listener>()

  return {
    getState() {
      return currentState
    },
    dispatch(action: A) {
      currentState = reducer(currentState, action)
      listeners.forEach((l) => l())
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const store = createStore<CartState, CartAction>(cartReducer, initialState)

// Expose for the storeIdentity probe used by the trace e2e test.
declare global {
  interface Window {
    __STORE__?: Store<CartState, CartAction>
  }
}
if (typeof window !== 'undefined') {
  window.__STORE__ = store
}
