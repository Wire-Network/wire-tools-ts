import type { RootState } from "../RootState.js"
import { SliceName } from "../StoreTypes.js"
import type {
  LogViewerState,
  ProcessLiveness,
  ProcessMonitorState
} from "./ProcessMonitorTypes.js"

/** Full process-monitor slice. */
export const selectProcessMonitor = (state: RootState): ProcessMonitorState =>
  state[SliceName.ProcessMonitor]

/** Label → liveness map. */
export const selectProcessMap = (
  state: RootState
): Record<string, ProcessLiveness> =>
  state[SliceName.ProcessMonitor].processes

/** Count of alive processes — drives the status-bar badge. */
export const selectAliveCount = (state: RootState): number =>
  Object.values(state[SliceName.ProcessMonitor].processes).filter(p => p.alive)
    .length

/** Current log-viewer user intent. */
export const selectLogViewer = (state: RootState): LogViewerState =>
  state[SliceName.ProcessMonitor].logViewer
