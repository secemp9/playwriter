import { useEffect, useState } from 'react'
import { formatDate } from '../utils/date'

interface Order {
  id: string
  customer: string
  // The mock API returns ISO 8601 timestamps here.
  placedAt: string
  amount: number
}

// Mock API: resolves with orders whose `placedAt` is an ISO 8601 string,
// which is exactly what the DD/MM/YYYY-assuming formatDate cannot handle.
function fetchOrders(): Promise<Order[]> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve([
        {
          id: 'ord-1001',
          customer: 'Ada Lovelace',
          placedAt: '2026-07-24T09:11:02Z',
          amount: 42.0,
        },
        {
          id: 'ord-1002',
          customer: 'Alan Turing',
          placedAt: '2026-07-22T16:03:47Z',
          amount: 128.5,
        },
      ])
    }, 40)
  })
}

export function OrderRow() {
  const [orders, setOrders] = useState<Order[]>([])

  useEffect(() => {
    let alive = true
    fetchOrders().then((data) => {
      if (alive) setOrders(data)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <section>
      <h2>Orders</h2>
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Customer</th>
            <th>Placed</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>{o.id}</td>
              <td>{o.customer}</td>
              {/* formatDate turns the ISO string into "Invalid Date" */}
              <td data-testid="order-date">{formatDate(o.placedAt)}</td>
              <td>${o.amount.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
