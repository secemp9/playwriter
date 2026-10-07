// Fixture for src/react-tree-live.test.ts: a real React 19 app (bundled by build.ts with a linked
// sourcemap) with keyed list items, props of every kind, a Suspense boundary that stays suspended
// until a button resolves its promise, one that never suspends, and a counter whose re-render the
// render-counting measurement looks for. Line numbers matter to the test only through the names.
import { Suspense, use, useState } from 'react'
import { createRoot } from 'react-dom/client'

let resolveDetails: (text: string) => void = () => {}
const details = new Promise<string>((resolve) => {
  resolveDetails = resolve
})

function Details() {
  const text = use(details)
  return <p className="details">{text}</p>
}

function Spinner() {
  return <p role="status">Loading details…</p>
}

function ProductCard({ name, price, onBuy }: { name: string; price: number; onBuy: (name: string) => void }) {
  return (
    <article aria-label={name}>
      <h2>{name}</h2>
      <button type="button" onClick={() => onBuy(name)}>
        Buy {name} for ${price}
      </button>
    </article>
  )
}

function ProductList({ products, onBuy }: { products: Array<{ id: string; name: string; price: number }>; onBuy: (name: string) => void }) {
  return (
    <section aria-label="Products">
      {products.map((product) => (
        <ProductCard key={product.id} name={product.name} price={product.price} onBuy={onBuy} />
      ))}
    </section>
  )
}

function Counter() {
  const [count, setCount] = useState(0)
  return (
    <button type="button" className="counter" onClick={() => setCount(count + 1)}>
      Clicked {count} times
    </button>
  )
}

function App() {
  const [bought, setBought] = useState<string[]>([])
  return (
    <main>
      <h1>React tree fixture</h1>
      <ProductList
        products={[
          { id: 'hub', name: 'USB-C Hub', price: 45 },
          { id: 'mouse', name: 'Wireless Mouse', price: 29 },
        ]}
        onBuy={(name) => setBought([...bought, name])}
      />
      <p role="status">Bought: {bought.join(', ') || 'nothing'}</p>
      <Counter />
      <Suspense fallback={<Spinner />}>
        <Details />
      </Suspense>
      <Suspense fallback={<Spinner />}>
        <p>Always ready</p>
      </Suspense>
      <button type="button" className="resolve" onClick={() => resolveDetails('Details loaded')}>
        Load details
      </button>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
