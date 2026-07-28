import { useEffect, useState } from 'react'

// Pure helper the effect depends on.
function computeBadge(unread: number): string {
  if (unread <= 0) return ''
  if (unread > 9) return '9+'
  return String(unread)
}

// BUG (d): the effect reads `unreadCount` but only lists `userId` in its
// dependency array. React therefore never re-runs the effect when the count
// changes, so the badge text is computed once and then goes STALE. Clicking
// "Mark unread +1" bumps unreadCount but the badge does not update (until an
// unrelated userId change happens to re-run the effect).
export function NotificationBadge() {
  const [userId, setUserId] = useState('user-1')
  const [unreadCount, setUnreadCount] = useState(0)
  const [badge, setBadge] = useState('')

  useEffect(() => {
    setBadge(computeBadge(unreadCount))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]) // <-- missing `unreadCount` dependency

  return (
    <section>
      <h2>Notifications</h2>
      <p>
        User: <strong>{userId}</strong>
      </p>
      <p>
        Unread (actual): <strong>{unreadCount}</strong>
      </p>
      <p>
        Badge (stale): <span data-testid="unread-badge">{badge || '—'}</span>
      </p>
      <button
        data-testid="mark-read"
        onClick={() => setUnreadCount((c) => c + 1)}
      >
        Mark unread +1
      </button>
      <button
        data-testid="switch-user"
        onClick={() =>
          setUserId((u) => (u === 'user-1' ? 'user-2' : 'user-1'))
        }
      >
        Switch user (forces effect re-run)
      </button>
    </section>
  )
}
