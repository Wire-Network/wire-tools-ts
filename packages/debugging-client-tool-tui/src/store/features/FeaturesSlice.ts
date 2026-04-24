import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { SliceName } from "../StoreTypes.js"

/** Lightweight view of a registered feature provider — suitable for UI display. */
export interface RegisteredFeatureProvider {
  id: string
  name: string
  core: boolean
}

/** Features slice — registry plus the active-id list derived from `--features`. */
export interface FeaturesSliceState {
  /** Every `FeatureProviderRegistry.add`'d provider, in insertion order. */
  registered: RegisteredFeatureProvider[]
  /** Ids that passed the `--features` filter (and any required providers). */
  activeIds: string[]
}

const initialState: FeaturesSliceState = { registered: [], activeIds: [] }

/** Features slice — registry + active-ids. */
export const featuresSlice = createSlice({
  name: SliceName.Features,
  initialState,
  reducers: {
    /** Append a provider to the registry if not already present. */
    registerFeature: (
      state,
      action: PayloadAction<RegisteredFeatureProvider>
    ) => {
      if (!state.registered.some(f => f.id === action.payload.id)) {
        state.registered.push(action.payload)
      }
    },
    /** Replace the active-ids list — called once during bootstrap. */
    setActiveFeatures: (state, action: PayloadAction<string[]>) => {
      state.activeIds = action.payload
    }
  }
})

export const { registerFeature, setActiveFeatures } = featuresSlice.actions
