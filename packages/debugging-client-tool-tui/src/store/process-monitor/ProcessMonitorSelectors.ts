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

/**
 * Total pid-source count tracked by the process monitor — covers WIRE nodes,
 * anvil, and solana-test-validator. Drives the status-bar `alive/total` badge.
 * Sourced from the liveness map (one entry per scanned pid file) rather than
 * `cluster.state` so non-node sources are included.
 */
export const selectTotalCount = (state: RootState): number =>
  Object.keys(state[SliceName.ProcessMonitor].processes).length

/** Current log-viewer user intent. */
export const selectLogViewer = (state: RootState): LogViewerState =>
  state[SliceName.ProcessMonitor].logViewer
