import { useState, useEffect } from 'react'

// BUG (i): the products state is replaced (not appended) when the "ad" loads
// because the ad-load effect unconditionally calls setProducts with the ad
// response (which is a single-element array). The spread operator intended to
// preserve existing products is missing, so the product list vanishes and only
// the ad is shown. This simulates a layout shift where legitimate content
// disappears when a third-party widget resolves.

interface Product {
  id: string
  name: string
  price: number
}

const INITIAL_PRODUCTS: Product[] = [
  { id: 'prod-1', name: 'Wireless Mouse', price: 29.99 },
  { id: 'prod-2', name: 'Mechanical Keyboard', price: 89.99 },
  { id: 'prod-3', name: 'USB-C Hub', price: 34.99 },
  { id: 'prod-4', name: 'Monitor Stand', price: 49.99 },
  { id: 'prod-5', name: 'Desk Lamp', price: 24.99 },
]

interface AdResponse {
  sponsored: Product[]
}

// Mock ad network: loads after a delay and returns a single sponsored product.
function loadAd(): Promise<AdResponse> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        sponsored: [
          { id: 'sponsored-1', name: 'Sponsored: Ergonomic Chair', price: 299.99 },
        ],
      })
    }, 2000)
  })
}

export function LayoutShift() {
  const [products, setProducts] = useState<Product[]>(INITIAL_PRODUCTS)
  const [adLoaded, setAdLoaded] = useState(false)

  // Load ad after mount. Intentionally overwrites instead of appending.
  useEffect(() => {
    loadAd().then((ad) => {
      // BUG: this REPLACES the entire products array instead of appending.
      // The fix would be: setProducts(prev => [...prev, ...ad.sponsored])
      setProducts(ad.sponsored)
      setAdLoaded(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleRestore() {
    setProducts(INITIAL_PRODUCTS)
    setAdLoaded(false)
  }

  return (
    <section>
      <h2>Product Catalog</h2>
      <p style={{ fontSize: 13, color: '#888' }}>
        Products disappear when the ad loads (wait 2 seconds).
      </p>

      <div
        data-testid="product-list"
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {products.map((p) => (
          <div
            key={p.id}
            data-testid={p.id.startsWith('prod-') ? 'product-item' : 'ad-item'}
            style={{
              padding: 12,
              border: p.id.startsWith('sponsored')
                ? '1px solid #ffd700'
                : '1px solid #ddd',
              borderRadius: 6,
              background: p.id.startsWith('sponsored') ? '#fffbe6' : '#fff',
            }}
          >
            <strong>{p.name}</strong>
            <span style={{ float: 'right' }}>${p.price.toFixed(2)}</span>
          </div>
        ))}
      </div>

      {products.length === 0 && (
        <p data-testid="empty-state" style={{ color: '#999' }}>
          No products to display.
        </p>
      )}

      {adLoaded && (
        <button
          data-testid="restore-products"
          onClick={handleRestore}
          style={{ marginTop: 12 }}
        >
          Restore Products
        </button>
      )}

      <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
        Status: {adLoaded ? 'Ad loaded — products vanished!' : 'Ad loading...'}
      </p>
    </section>
  )
}
