/**
 * Test fixture for the new browser (new-browser-live.test.ts, mcp-new-browser.test.ts): serves
 * test/fixtures/browser-new on an ephemeral port. Its identity.html reports how the page, dedicated,
 * shared and service worker scopes present the browser (POST /report); the lab witness reports
 * automation traces (POST /witness); every request's headers are recorded.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { z } from 'zod'

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'fixtures', 'browser-new')

const brandSchema = z.object({ brand: z.string(), version: z.string() })
const scopeSchema = z.object({
  userAgent: z.string(),
  platform: z.string(),
  webdriver: z.boolean().optional(),
  language: z.string(),
  languages: z.array(z.string()),
  timeZone: z.string(),
  modelContext: z.boolean(),
  highEntropy: z
    .object({
      brands: z.array(brandSchema),
      mobile: z.boolean(),
      platform: z.string(),
      architecture: z.string(),
      bitness: z.string(),
      formFactors: z.array(z.string()),
      fullVersionList: z.array(brandSchema),
      model: z.string(),
      platformVersion: z.string(),
      uaFullVersion: z.string(),
      wow64: z.boolean(),
    })
    .nullable(),
})
const answerSchema = z.object({ scope: scopeSchema, fetched: z.string().nullable() })
const identityReportSchema = z.object({
  tag: z.string(),
  page: answerSchema,
  dedicated: answerSchema,
  shared: answerSchema,
  service: answerSchema,
  webglRenderer: z.string().nullable(),
  screen: z.object({ width: z.number(), height: z.number(), availWidth: z.number(), availHeight: z.number() }),
  window: z.object({ innerWidth: z.number(), innerHeight: z.number(), outerWidth: z.number(), outerHeight: z.number(), devicePixelRatio: z.number() }),
  media: z.object({ dark: z.boolean(), coarse: z.boolean() }),
  touchPoints: z.number(),
})
export type IdentityReport = z.infer<typeof identityReportSchema>

const witnessSchema = z.object({
  tag: z.string(),
  webdriver: z.boolean(),
  automationGlobals: z.array(z.string()),
  consoleGetterCalls: z.number(),
  probes: z.number(),
})

/** What the fixture server saw: reports, witness beacons and the headers of every request. */
export interface FixtureServer {
  url: string
  /** The same server under another host name (localhost), for allowedDomains. */
  otherHostUrl: string
  reports: IdentityReport[]
  witness: Array<z.infer<typeof witnessSchema>>
  requests: Array<{ path: string; host: string | undefined; userAgent: string | undefined; secChUa: string | undefined; acceptLanguage: string | undefined }>
  close(): Promise<void>
}

/** Serves test/fixtures/browser-new; POST /report and /witness are recorded, /download/* is an attachment, /ping answers pong. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const reports: IdentityReport[] = []
  const witness: FixtureServer['witness'] = []
  const requests: FixtureServer['requests'] = []
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
    requests.push({
      path: pathname,
      host: request.headers.host,
      userAgent: request.headers['user-agent'],
      secChUa: typeof request.headers['sec-ch-ua'] === 'string' ? request.headers['sec-ch-ua'] : undefined,
      acceptLanguage: request.headers['accept-language'],
    })
    if (request.method === 'POST') {
      let body = ''
      request.on('data', (chunk: Buffer) => (body += chunk.toString()))
      request.on('end', () => {
        if (pathname === '/report') reports.push(identityReportSchema.parse(JSON.parse(body)))
        if (pathname === '/witness') {
          const parsed = witnessSchema.safeParse(JSON.parse(body))
          if (parsed.success) witness.push(parsed.data)
        }
        response.writeHead(204).end()
      })
      return
    }
    if (pathname.startsWith('/download/')) {
      response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${path.basename(pathname)}"` })
      response.end('id,name\n1,Ada\n')
      return
    }
    if (pathname === '/ping') {
      response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('pong')
      return
    }
    const file = path.join(FIXTURES, pathname === '/' ? 'identity.html' : pathname)
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file)) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' })
    response.end(fs.readFileSync(file))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the fixture server has no TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    otherHostUrl: `http://localhost:${address.port}`,
    reports,
    witness,
    requests,
    close: () => {
      const closed = Promise.withResolvers<void>()
      server.closeAllConnections()
      server.close(() => closed.resolve())
      return closed.promise
    },
  }
}

/** Waits for the report tagged `tag`. Real timers: the page posts it from its own event loop, in another process. */
export async function reportFor(server: FixtureServer, tag: string, timeoutMs = 15_000): Promise<IdentityReport> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = server.reports.find((report) => report.tag === tag)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`no report tagged ${tag} within ${timeoutMs} ms`)
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 100)
    await tick.promise
  }
}

/** Waits for a witness beacon tagged `tag` that ran at least one probe (the witness reports every second). Real timers, as reportFor. */
export async function witnessFor(server: FixtureServer, tag: string, timeoutMs = 15_000): Promise<FixtureServer['witness'][number]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = server.witness.filter((entry) => entry.tag === tag && entry.probes > 0).at(-1)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`no witness report tagged ${tag} within ${timeoutMs} ms`)
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 100)
    await tick.promise
  }
}
