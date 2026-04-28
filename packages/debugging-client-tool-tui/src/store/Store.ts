import { configureStore } from "@reduxjs/toolkit"
import {
  useDispatch,
  useSelector,
  type TypedUseSelectorHook
} from "react-redux"
import { SliceName } from "./StoreTypes.js"
import { createReduxFileLogger } from "./middleware/createReduxFileLogger.js"
import { uiSlice } from "./ui/UISlice.js"
import { clusterSlice } from "./cluster/ClusterSlice.js"
import { featuresSlice } from "./features/FeaturesSlice.js"
import { oppSlice } from "./opp/OPPSlice.js"
import { processMonitorSlice } from "./process-monitor/ProcessMonitorSlice.js"

/**
 * Action types that carry protobuf-decoded payloads. RTK's serializableCheck
 * middleware is relaxed for these — the OPP tracking service `plainify`s
 * BigInts and Uint8Arrays before dispatch, but this second line of defense
 * avoids spurious warnings if any leak through.
 */
const IgnoredSerializableActions = [
  "opp/appendEnvelope",
  "opp/hydrate"
] as const

/**
 * TUI Redux store. Single source of truth for every slice. The
 * `createReduxFileLogger()` middleware is always installed; it gates itself
 * on `LoggingManager`'s root level via its `predicate`, so it's a one-boolean
 * no-op until the user passes `--log-level debug`.
 */
export const store = configureStore({
  reducer: {
    [SliceName.UI]: uiSlice.reducer,
    [SliceName.Cluster]: clusterSlice.reducer,
    [SliceName.Features]: featuresSlice.reducer,
    [SliceName.OPP]: oppSlice.reducer,
    [SliceName.ProcessMonitor]: processMonitorSlice.reducer
  },
  middleware: getDefault =>
    getDefault({
      serializableCheck: { ignoredActions: [...IgnoredSerializableActions] }
    }).concat(createReduxFileLogger())
})

/** RootState inferred from the store — avoids repeating the shape. */
export type RootState = ReturnType<typeof store.getState>
/** Dispatch with thunk-aware typing. */
export type AppDispatch = typeof store.dispatch

/** Typed dispatch hook. Components must use this over bare `useDispatch`. */
export const useAppDispatch = (): AppDispatch => useDispatch<AppDispatch>()
/** Typed selector hook. */
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
