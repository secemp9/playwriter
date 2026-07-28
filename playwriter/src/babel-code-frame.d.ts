// Minimal ambient types for @babel/code-frame (ships no .d.ts and no @types is
// available offline). Covers only the surface used by source-provenance.ts.
declare module '@babel/code-frame' {
  export interface CodeFrameLocation {
    line: number
    column?: number
  }
  export interface CodeFrameNodeLocation {
    start: CodeFrameLocation
    end?: CodeFrameLocation
  }
  export interface CodeFrameOptions {
    highlightCode?: boolean
    message?: string
    forceColor?: boolean
    linesAbove?: number
    linesBelow?: number
  }
  export function codeFrameColumns(
    rawLines: string,
    location: CodeFrameNodeLocation,
    options?: CodeFrameOptions,
  ): string
}
