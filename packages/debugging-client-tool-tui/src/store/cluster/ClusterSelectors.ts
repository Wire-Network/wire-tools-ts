import type { RootState } from "../RootState.js"
import { SliceName } from "../StoreTypes.js"
import type { ClusterSliceState } from "./ClusterSlice.js"

/** Select the full cluster slice. */
export const selectCluster = (state: RootState): ClusterSliceState =>
  state[SliceName.Cluster]
