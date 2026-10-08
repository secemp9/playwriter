import type { ExtensionState } from 'mcp-extension/src/types.js'
import type { SelfReloadOutcome } from 'mcp-extension/src/self-reload.js'

declare global {
  var toggleExtensionForActiveTab: (
    workspaceKey: string | null,
    workspaceLabel: string | null,
  ) => Promise<{ isConnected: boolean; state: ExtensionState }>
  var getExtensionState: () => ExtensionState
  var disconnectEverything: () => Promise<void>
  /** Calls `listener` on every change of the extension's state; returns the unsubscribe (extension/src/background.ts). */
  var subscribeExtensionState: (listener: (state: ExtensionState) => void) => () => void
  var checkForNewerBuild: () => Promise<SelfReloadOutcome>

  // Browser globals used in evaluate() calls
  var window: any
  var document: any
}

export {}
