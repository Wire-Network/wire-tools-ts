import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { SliceName } from "../StoreTypes.js"
import type {
  LogViewerState,
  ProcessLiveness,
  ProcessMonitorState
} from "./ProcessMonitorTypes.js"

const initialLogViewer: LogViewerState = { path: null, offset: 0, follow: true }
const initialState: ProcessMonitorState = {
  processes: {},
  logViewer: initialLogViewer
}

/** Process-monitor slice — liveness map + log-viewer user intent. */
export const processMonitorSlice = createSlice({
  name: SliceName.ProcessMonitor,
  initialState,
  reducers: {
    /** Upsert liveness by label. */
    setProcess: (state, action: PayloadAction<ProcessLiveness>) => {
      state.processes[action.payload.label] = action.payload
    },
    /** Drop a liveness record — used when a node disappears from `ClusterState`. */
    removeProcess: (state, action: PayloadAction<string>) => {
      delete state.processes[action.payload]
    },
    /** Switch the viewer to a new log file; resets offset and enables follow. */
    setLogViewerPath: (state, action: PayloadAction<string | null>) => {
      state.logViewer.path = action.payload
      state.logViewer.offset = 0
      state.logViewer.follow = true
    },
    /** Absolute-offset scroll; disables follow (explicit user intent). */
    setLogViewerOffset: (state, action: PayloadAction<number>) => {
      state.logViewer.offset = Math.max(0, action.payload)
      state.logViewer.follow = false
    },
    /** Toggle/restore follow mode. */
    setLogViewerFollow: (state, action: PayloadAction<boolean>) => {
      state.logViewer.follow = action.payload
    }
  }
})

export const {
  setProcess,
  removeProcess,
  setLogViewerPath,
  setLogViewerOffset,
  setLogViewerFollow
} = processMonitorSlice.actions
