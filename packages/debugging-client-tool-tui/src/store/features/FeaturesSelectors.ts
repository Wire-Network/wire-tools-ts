import type { RootState } from "../RootState.js"
import { SliceName } from "../StoreTypes.js"
import type { FeaturesSliceState } from "./FeaturesSlice.js"

/** Select the full features slice. */
export const selectFeatures = (state: RootState): FeaturesSliceState =>
  state[SliceName.Features]
