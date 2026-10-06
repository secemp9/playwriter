/**
 * The highlight Chrome's element picker draws (`Overlay.setInspectMode`). Shared by the
 * agent-initiated picker (`element-pins.ts`) and the extension's context-menu picker so the
 * human sees one picker, whoever started it. Dependency-free: the extension bundles it.
 *
 * DevTools' own element-highlight colours, so it looks like the picker humans already know.
 */

import type { Protocol } from 'devtools-protocol'

export const PICKER_HIGHLIGHT_CONFIG: Protocol.Overlay.HighlightConfig = {
  showInfo: true,
  showStyles: false,
  showAccessibilityInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
}
