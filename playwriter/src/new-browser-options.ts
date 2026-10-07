/**
 * new-browser-options.ts — the options of a new browser (`browser({ action: 'new', … })` in the MCP
 * server, `CdpConfig.newBrowser` in the executor), as the model writes them. Validated here by shape
 * only; new-browser.ts checks what needs the browser binary, Playwright's device list or the session's
 * folders. This module stays light (zod only): the MCP server builds its tool schema from it at startup.
 */

import { z } from 'zod'

export const viewportSchema = z
  .object({
    width: z.number().int().min(200).max(7680),
    height: z.number().int().min(200).max(4320),
  })
  .strict()

/** One shape per option, so the MCP `browser` tool can list them flat next to `action`. */
export const newBrowserOptionShapes = {
  viewport: viewportSchema
    .optional()
    .describe('With new: the page size in CSS pixels, e.g. { width: 1280, height: 720 } (the default). The browser window is sized around it.'),
  device: z
    .string()
    .optional()
    .describe('With new: a phone, tablet or desktop preset by name, e.g. "Pixel 7", "Galaxy Tab S9", "Desktop Chrome HiDPI": its screen, pixel ratio, touch and user agent. Not with viewport or userAgent.'),
  userAgent: z
    .string()
    .min(1)
    .optional()
    .describe("With new: the User-Agent every page, worker and request sends. Default: the launched Chrome's own, as a person's Chrome of that version sends it."),
  locale: z.string().min(2).optional().describe('With new: the browser language, e.g. "fr-FR" (navigator.language, Accept-Language, Intl). Default: the computer\'s.'),
  timezone: z.string().min(1).optional().describe('With new: an IANA time zone, e.g. "America/New_York". Default: the computer\'s.'),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional().describe('With new: what prefers-color-scheme matches. Default: light.'),
  headed: z.boolean().optional().describe('With new: show the browser window (needs a display; refused on a server without one). Default: headless.'),
  allowedDomains: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'With new: the only hosts the browser may contact, e.g. ["example.com", "127.0.0.1"]. An entry allows that host and its subdomains ("*.example.com": subdomains only). Requests to any other host fail and the report says they were blocked.',
    ),
  downloads: z
    .string()
    .min(1)
    .optional()
    .describe('With new: a folder (in the session folder or /tmp) where every finished download is also saved under its own file name.'),
}

export const newBrowserOptionsSchema = z.object(newBrowserOptionShapes).strict()

export type NewBrowserOptions = z.infer<typeof newBrowserOptionsSchema>
