/**
 * network-lab-fixture.ts — the Browser Lab's errors and network pages (test/fixtures/browser-lab) and
 * the endpoints they call, served for tests on an ephemeral port.
 *
 * One server answers on every interface of its port, so `http://127.0.0.1:<port>` and
 * `http://localhost:<port>` are two origins of it: network.html's "Cross-origin request (CORS)"
 * fetches `/api/cors-fail` from the other one, which answers without `Access-Control-Allow-Origin`
 * and so is blocked by Chrome, as in the lab (TRUTH §2, §3.10).
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/browser-lab')

/** The lab's report.csv (TRUTH §2): 317 bytes. */
export const LAB_REPORT_CSV =
  'invoice,customer,date,amount,status\n' +
  'INV-1001,Acme Corp,2026-01-05,1200.00,Paid\n' +
  'INV-1002,Globex,2026-01-12,830.50,Pending\n' +
  'INV-1003,Initech,2026-01-19,2400.00,Overdue\n' +
  'INV-1004,Umbrella Health,2026-01-26,415.75,Paid\n' +
  'INV-1005,Stark Industries,2026-02-02,9999.99,Pending\n' +
  'INV-1006,Wayne Enterprises,2026-02-09,3050.00,Paid\n'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export interface NetworkLab {
  /** `http://127.0.0.1:<port>` — the pages' origin. */
  origin: string
  /** `http://localhost:<port>` — the other origin network.html's CORS request goes to. */
  otherOrigin: string
  port: number
  /** Every request the server answered, `METHOD path`, in order. */
  served: string[]
  close(): Promise<void>
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(Buffer.byteLength(text)), 'Cache-Control': 'no-store', ...headers })
  res.end(text)
}

export async function startNetworkLab(): Promise<NetworkLab> {
  const served: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab')
    served.push(`${req.method} ${url.pathname}`)
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (url.pathname === '/api/user') return json(res, 200, { id: 7, name: 'Ada Lovelace', role: 'admin' }, { 'Set-Cookie': 'lab-session=abc123; Path=/; HttpOnly' })
      if (url.pathname === '/api/status/404') return json(res, 404, { error: 'Not Found', status: 404 })
      if (url.pathname === '/api/status/500') return json(res, 500, { error: 'Internal Server Error', status: 500 })
      if (url.pathname === '/api/cors-fail') return json(res, 200, { ok: true, secret: 'cross-site data' })
      if (url.pathname === '/api/slow') {
        const ms = Math.min(10_000, Math.max(0, Number(url.searchParams.get('ms') ?? 1000)))
        // Real timer: the server answers a real browser's request after a real delay.
        setTimeout(() => json(res, 200, { ok: true, ms }), ms)
        return
      }
      if (url.pathname === '/api/echo') {
        if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' })
        const raw = Buffer.concat(chunks).toString('utf8')
        const body: unknown = req.headers['content-type']?.startsWith('application/json') ? JSON.parse(raw) : raw
        return json(res, 200, { method: 'POST', path: '/api/echo', body, headers: req.headers })
      }
      if (url.pathname === '/download/report.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="report.csv"', 'Content-Length': String(LAB_REPORT_CSV.length) })
        res.end(LAB_REPORT_CSV)
        return
      }
      // The documents of play-runners.html's iframes (MDN's live examples): on MDN, Chrome delivered
      // them one by one over a minute (they answer with Clear-Site-Data, and Chrome clears the site's
      // data first). A test browser holds such a document only when that clearing starts within its
      // first ~5 s (measured, Chromium 145 headless: 4 s after launch, held 45 s and more; 7 s and later,
      // delivered in ~0.1 s), which no test run guarantees. The lab never answers it instead: Chrome
      // has sent the request and has no response, on any machine, until the frame goes away.
      if (url.pathname === '/play-runner.html') return
      const file = path.join(ROOT, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''))
      if (file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
        res.end(fs.readFileSync(file))
        return
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('Not Found')
    })
  })
  const listening = Promise.withResolvers<void>()
  // No host: every interface, IPv4 and IPv6, so `localhost` reaches it whichever address it resolves to.
  server.listen(0, () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('network lab server has no port')
  const port = address.port
  return {
    origin: `http://127.0.0.1:${port}`,
    otherOrigin: `http://localhost:${port}`,
    port,
    served,
    close: async () => {
      const closed = Promise.withResolvers<void>()
      server.closeAllConnections()
      server.close(() => closed.resolve())
      await closed.promise
    },
  }
}
