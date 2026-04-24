/** Liveness snapshot for one spawned harness process. */
export interface ProcessLiveness {
  /** Harness label — filename without `.pid`. */
  label: string
  /** Parsed from pid file, or null when file is missing/unreadable. */
  pid: number | null
  /** True when `process.kill(pid, 0)` succeeds. */
  alive: boolean
  /** Unix ms of the last `poll()` tick that touched this record. */
  lastCheckedAt: number
  /** Unix ms of the first tick that observed `alive` flipping true→false. */
  exitedAt: number | null
}

/** User-intent state for the log viewer. Runtime counters live in `LogTailingService`, not Redux. */
export interface LogViewerState {
  /** Absolute path of the file under view; null = no selection. */
  path: string | null
  /** Top-of-viewport line index (0-based); ignored while `follow=true`. */
  offset: number
  /** When true, panel auto-pins offset to tail-minus-viewport-height. */
  follow: boolean
}

/** Process-monitor slice shape. */
export interface ProcessMonitorState {
  /** Liveness by label — one entry per cluster node. */
  processes: Record<string, ProcessLiveness>
  /** Log-viewer user intent. */
  logViewer: LogViewerState
}
