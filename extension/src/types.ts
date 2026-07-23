export type ConnectionState = 'idle' | 'connected' | 'extension-replaced'
export type TabState = 'connecting' | 'connected' | 'error'

export interface TabInfo {
  sessionId?: string
  targetId?: string
  state: TabState
  errorText?: string
  attachOrder?: number
  isRecording?: boolean
  /**
   * Workspace that owns this tab (I2). Required and explicitly nullable:
   * null POSITIVELY means freestyle (a human clicked the extension icon), which
   * is visible to no workspace, ever — never "ownership unknown" and never a
   * migration placeholder to be defaulted away. A programmatic (auto-created)
   * tab always carries a real key here.
   */
  workspaceKey: string | null
  /**
   * Human-readable label for the owning workspace, carried so the extension can
   * title this tab's group (Todo 22). null iff workspaceKey is null (freestyle).
   */
  workspaceLabel: string | null
}

export interface ExtensionState {
  tabs: Map<number, TabInfo>
  connectionState: ConnectionState
  currentTabId: number | undefined
  preferredWindowId: number | undefined
  errorText: string | undefined
}

/**
 * Recording state - stored in service worker to track active recordings.
 * The actual MediaRecorder/MediaStream live in the offscreen document.
 */
export interface RecordingInfo {
  tabId: number
  startedAt: number
}
