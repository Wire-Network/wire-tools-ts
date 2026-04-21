import {
  configureStore,
  createSlice,
  type PayloadAction
} from "@reduxjs/toolkit"
import {
  useDispatch,
  useSelector,
  type TypedUseSelectorHook
} from "react-redux"

import type {
  ClusterConfig,
  ClusterState
} from "@wire-e2e-tests/debugging-shared"

// ---------------------------------------------------------------------------
//  Slice identifiers — referenced by name in `configureStore` and selectors
//  to keep string literals out of call sites.
// ---------------------------------------------------------------------------

export namespace Store {
  export const UISliceName = "ui" as const
  export const ClusterSliceName = "cluster" as const
  export const FeaturesSliceName = "features" as const

  /** Starting status string for a fresh session. */
  export const DefaultStatus = "idle" as const
}

// ---------------------------------------------------------------------------
//  UI slice — header status, shared-UI ephemera.
// ---------------------------------------------------------------------------

export interface UIState {
  /** Single-line status message shown in the header. */
  status: string
}

const uiInitialState: UIState = { status: Store.DefaultStatus }

const uiSlice = createSlice({
  name: Store.UISliceName,
  initialState: uiInitialState,
  reducers: {
    setStatus: (state, action: PayloadAction<string>) => {
      state.status = action.payload
    }
  }
})

export const { setStatus } = uiSlice.actions

// ---------------------------------------------------------------------------
//  Cluster slice — snapshot of cluster-config.json + cluster-state.json.
// ---------------------------------------------------------------------------

export interface ClusterSliceState {
  /** Absolute path to the cluster directory. */
  path: string | null
  /** Resolved `cluster-config.json`. */
  config: ClusterConfig | null
  /** Resolved `cluster-state.json`. Null until the cluster has bootstrapped. */
  state: ClusterState | null
}

const clusterInitialState: ClusterSliceState = {
  path: null,
  config: null,
  state: null
}

export interface SetClusterPayload {
  path: string
  config: ClusterConfig
  state: ClusterState | null
}

const clusterSlice = createSlice({
  name: Store.ClusterSliceName,
  initialState: clusterInitialState,
  reducers: {
    setCluster: (state, action: PayloadAction<SetClusterPayload>) => {
      state.path = action.payload.path
      state.config = action.payload.config
      state.state = action.payload.state
    }
  }
})

export const { setCluster } = clusterSlice.actions

// ---------------------------------------------------------------------------
//  Features slice — registered debuggers + currently active feature.
// ---------------------------------------------------------------------------

export interface RegisteredFeature {
  id: string
  name: string
  core: boolean
}

export interface FeaturesSliceState {
  /** Every `FeatureDebugger.add`'d debugger, in registration order. */
  registered: RegisteredFeature[]
  /** Active feature debugger id, or null when only core is visible. */
  activeId: string | null
}

const featuresInitialState: FeaturesSliceState = {
  registered: [],
  activeId: null
}

const featuresSlice = createSlice({
  name: Store.FeaturesSliceName,
  initialState: featuresInitialState,
  reducers: {
    registerFeature: (state, action: PayloadAction<RegisteredFeature>) => {
      if (!state.registered.some(f => f.id === action.payload.id)) {
        state.registered.push(action.payload)
      }
    },
    setActiveFeature: (state, action: PayloadAction<string | null>) => {
      state.activeId = action.payload
    }
  }
})

export const { registerFeature, setActiveFeature } = featuresSlice.actions

// ---------------------------------------------------------------------------
//  Store + typed hooks helpers
// ---------------------------------------------------------------------------

export const store = configureStore({
  reducer: {
    [Store.UISliceName]: uiSlice.reducer,
    [Store.ClusterSliceName]: clusterSlice.reducer,
    [Store.FeaturesSliceName]: featuresSlice.reducer
  }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch

/**
 * Typed `useDispatch` bound to the TUI store. Always prefer this over the
 * raw `useDispatch` so thunks and action payloads are fully inferred.
 */
export const useAppDispatch = (): AppDispatch => useDispatch<AppDispatch>()

/**
 * Typed `useSelector` bound to the TUI `RootState`. Always prefer this over
 * the raw `useSelector` so selectors know what slices exist.
 */
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector

/** Selector: UI ephemera. */
export const selectUI = (state: RootState): UIState => state[Store.UISliceName]

/** Selector: the loaded cluster snapshot. */
export const selectCluster = (state: RootState): ClusterSliceState =>
  state[Store.ClusterSliceName]

/** Selector: features registry + active id. */
export const selectFeatures = (state: RootState): FeaturesSliceState =>
  state[Store.FeaturesSliceName]
