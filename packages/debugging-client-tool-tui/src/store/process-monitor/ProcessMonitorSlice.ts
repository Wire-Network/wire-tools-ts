import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { SliceName } from "../StoreTypes.js"
import type {
  LogViewerState,
  ProcessLiveness,
  ProcessMonitorState
} from "./ProcessMonitorTypes.js"

const initialLogViewer: LogViewerState = {
  path: null,
  offset: 0,
  follow: true,
  horizontalOffset: 0,
  searchActive: false,
  searchQuery: "",
  locationVisible: false
}
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
    /**
     * Switch the viewer to a new log file. Resets every per-file viewer field —
     * vertical + horizontal offset to 0, follow back on, search cleared. The
     * `locationVisible` flag is intentionally NOT reset because it's a sticky
     * UI preference, not a per-file setting.
     */
    setLogViewerPath: (state, action: PayloadAction<string | null>) => {
      state.logViewer.path = action.payload
      state.logViewer.offset = 0
      state.logViewer.horizontalOffset = 0
      state.logViewer.follow = true
      state.logViewer.searchActive = false
      state.logViewer.searchQuery = ""
    },
    /** Absolute-offset scroll; disables follow (explicit user intent). */
    setLogViewerOffset: (state, action: PayloadAction<number>) => {
      state.logViewer.offset = Math.max(0, action.payload)
      state.logViewer.follow = false
    },
    /** Toggle/restore follow mode. */
    setLogViewerFollow: (state, action: PayloadAction<boolean>) => {
      state.logViewer.follow = action.payload
    },
    /** Horizontal-pan offset (in characters). Negative values clamp to 0. */
    setLogViewerHorizontalOffset: (
      state,
      action: PayloadAction<number>
    ) => {
      state.logViewer.horizontalOffset = Math.max(0, action.payload)
    },
    /**
     * Show / hide the search input. Closing always clears `searchQuery` so
     * the next open starts blank and stale highlights aren't kept on screen.
     */
    setSearchActive: (state, action: PayloadAction<boolean>) => {
      state.logViewer.searchActive = action.payload
      if (!action.payload) state.logViewer.searchQuery = ""
    },
    /** Update the active search term (drives match highlighting). */
    setSearchQuery: (state, action: PayloadAction<string>) => {
      state.logViewer.searchQuery = action.payload
    },
    /** Flip the source-location column on/off (JSONL view only). */
    toggleLocationColumn: state => {
      state.logViewer.locationVisible = !state.logViewer.locationVisible
    }
  }
})

export const {
  setProcess,
  removeProcess,
  setLogViewerPath,
  setLogViewerOffset,
  setLogViewerFollow,
  setLogViewerHorizontalOffset,
  setSearchActive,
  setSearchQuery,
  toggleLocationColumn
} = processMonitorSlice.actions
