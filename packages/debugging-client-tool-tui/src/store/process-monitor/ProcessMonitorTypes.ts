import type { ProcessLivenessSnapshot } from "@wireio/debugging-shared"

/** User-intent state for the log viewer. Runtime counters live in `LogTailingService`, not Redux. */
export interface LogViewerState {
  /** Absolute path of the file under view; null = no selection. */
  path: string | null
  /** Top-of-viewport line index (0-based); ignored while `follow=true`. */
  offset: number
  /** When true, panel auto-pins offset to tail-minus-viewport-height. */
  follow: boolean
  /** Number of leading characters dropped from each visible line (horizontal scroll). */
  horizontalOffset: number
  /** When true, the search input widget is mounted + captures keystrokes. */
  searchActive: boolean
  /** Current search term — empty string when no search is active or pending. */
  searchQuery: string
  /** When true, the JSONL view shows the source-location column between category and msg. */
  locationVisible: boolean
}

/** Process-monitor slice shape. */
export interface ProcessMonitorState {
  /** Liveness by label — one entry per cluster node (the debugging-shared snapshot type; no local mirror). */
  processes: Record<string, ProcessLivenessSnapshot>
  /** Log-viewer user intent. */
  logViewer: LogViewerState
}
