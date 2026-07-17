import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import type {
  ClusterState,
  PersistedClusterConfig
} from "@wireio/debugging-shared"
import { SliceName } from "../StoreTypes.js"

/** Snapshot of the loaded cluster directory. */
export interface ClusterSliceState {
  /** Absolute path to the cluster directory. */
  path: string | null
  /** Resolved `cluster-config.json`. */
  config: PersistedClusterConfig | null
  /** Resolved `cluster-state.json`. Null until the cluster has bootstrapped. */
  state: ClusterState | null
}

const initialState: ClusterSliceState = {
  path: null,
  config: null,
  state: null
}

/** Payload for {@link setCluster}. */
export interface SetClusterPayload {
  path: string
  config: PersistedClusterConfig
  state: ClusterState | null
}

/** Cluster slice — owns the loaded cluster config + state. */
export const clusterSlice = createSlice({
  name: SliceName.Cluster,
  initialState,
  reducers: {
    /** Replace the cluster snapshot — called once at TUI bootstrap. */
    setCluster: (state, action: PayloadAction<SetClusterPayload>) => {
      state.path = action.payload.path
      state.config = action.payload.config
      state.state = action.payload.state
    }
  }
})

export const { setCluster } = clusterSlice.actions
