import { CDPEventFor, ProtocolMapping } from './cdp-types.js'

export const VERSION = 1

type ForwardCDPCommand = {
  [K in keyof ProtocolMapping.Commands]: {
    id: number
    method: 'forwardCDPCommand'
    params: {
      method: K
      sessionId?: string
      params?: ProtocolMapping.Commands[K]['paramsType'][0]
      source?: 'playwriter'
      /**
       * Todo 20: the requesting client's workspace, injected by the relay onto the
       * forwarded `Target.createTarget` (context.newPage()) so the extension can stamp
       * the new tab's ownership (I2) — otherwise the extension has no way to know which
       * client asked for the page. Present only on `Target.createTarget`; a value of null
       * means the requesting client is genuinely freestyle/keyless (disconnect race, I1).
       * `undefined` means no workspace was injected (e.g. an older relay) — the extension
       * must fail loudly rather than mis-own the tab (Todo 33 owns version-skew warnings).
       */
      workspaceKey?: string | null
      workspaceLabel?: string | null
    }
  }
}[keyof ProtocolMapping.Commands]

export type ExtensionCommandMessage = ForwardCDPCommand

export type ExtensionResponseMessage = {
  id: number
  method?: undefined
  result?: any
  error?: string
}

/**
 * This produces a discriminated union for narrowing, similar to ForwardCDPCommand,
 * but for forwarded CDP events. Uses CDPEvent to maintain proper type extraction.
 */
export type ExtensionEventMessage = {
  [K in keyof ProtocolMapping.Events]: {
    id?: undefined
    method: 'forwardCDPEvent'
    params: {
      method: CDPEventFor<K>['method']
      sessionId?: string
      params?: CDPEventFor<K>['params']
      /**
       * Todo 20: the extension echoes the owning workspace key on every
       * `Target.attachedToTarget` it reports (the tab's own key for a page target, the
       * parent tab's key for a child/OOPIF target) so the relay can stamp
       * ConnectedTarget.workspaceKey instead of null. This is what makes live
       * target-scoped events (Todo 17) reach the owning client for extension-attached
       * tabs. null = freestyle (human icon-click), which is visible to no workspace.
       * `undefined` = an older extension that does not echo — the relay treats it as
       * freestyle (its pre-Todo-20 behaviour); Todo 33 owns the loud version-skew warning.
       */
      workspaceKey?: string | null
    }
  }
}[keyof ProtocolMapping.Events]

export type ExtensionLogMessage = {
  id?: undefined
  method: 'log'
  params: {
    level: 'log' | 'debug' | 'info' | 'warn' | 'error'
    args: string[]
  }
}

export type ExtensionPongMessage = {
  id?: undefined
  method: 'pong'
}

export type ServerPingMessage = {
  method: 'ping'
  id?: undefined
}

export type RecordingDataMessage = {
  id?: undefined
  method: 'recordingData'
  params: {
    tabId: number
    final?: boolean
  }
}

export type RecordingCancelledMessage = {
  id?: undefined
  method: 'recordingCancelled'
  params: {
    tabId: number
  }
}

export type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionEventMessage
  | ExtensionLogMessage
  | ExtensionPongMessage
  | RecordingDataMessage
  | RecordingCancelledMessage

// Recording command messages (MCP -> Extension via relay)
export type StartRecordingParams = {
  /** CDP tab session ID (pw-tab-*) to identify which tab to record. */
  sessionId?: string
  frameRate?: number
  audio?: boolean
  videoBitsPerSecond?: number
  audioBitsPerSecond?: number
}

/** HTTP body for /recording/start endpoint */
export type StartRecordingBody = StartRecordingParams & {
  outputPath: string
}

export type StopRecordingParams = {
  /** CDP tab session ID (pw-tab-*) to identify which tab to stop recording. */
  sessionId?: string
}

export type IsRecordingParams = {
  /** CDP tab session ID (pw-tab-*) to identify which tab to check. */
  sessionId?: string
}

export type CancelRecordingParams = {
  /** CDP tab session ID (pw-tab-*) to identify which tab to cancel. */
  sessionId?: string
}

export type StartRecordingMessage = {
  id: number
  method: 'startRecording'
  params: StartRecordingParams
}

export type StopRecordingMessage = {
  id: number
  method: 'stopRecording'
  params: StopRecordingParams
}

export type IsRecordingMessage = {
  id: number
  method: 'isRecording'
  params: IsRecordingParams
}

export type CancelRecordingMessage = {
  id: number
  method: 'cancelRecording'
  params: CancelRecordingParams
}

export type RecordingCommandMessage =
  | StartRecordingMessage
  | StopRecordingMessage
  | IsRecordingMessage
  | CancelRecordingMessage

// Recording result types
export type StartRecordingResult =
  | {
      success: true
      tabId: number
      startedAt: number
    }
  | {
      success: false
      error: string
    }

/** Result from extension - doesn't include path/size since relay writes the file */
export type ExtensionStopRecordingResult =
  | {
      success: true
      tabId: number
      duration: number
    }
  | {
      success: false
      error: string
    }

/** Final result from relay - includes path/size after file is written */
export type StopRecordingResult =
  | {
      success: true
      tabId: number
      duration: number
      path: string
      size: number
    }
  | {
      success: false
      error: string
    }

export type IsRecordingResult = {
  isRecording: boolean
  tabId?: number
  startedAt?: number
}

export type CancelRecordingResult = {
  success: boolean
  error?: string
}

// Ghost Browser API command message (for Ghost Browser integration)
export type GhostBrowserCommandMessage = {
  id: number
  method: 'ghost-browser'
  params: {
    /** API namespace: 'ghostPublicAPI' | 'ghostProxies' | 'projects' */
    namespace: 'ghostPublicAPI' | 'ghostProxies' | 'projects'
    /** Method name within the namespace */
    method: string
    /** Arguments to pass to the method */
    args: unknown[]
  }
}

export type GhostBrowserCommandResult =
  | {
      success: true
      result: unknown
    }
  | {
      success: false
      error: string
    }
