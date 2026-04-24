import type { RootState } from "../RootState.js"
import { SliceName } from "../StoreTypes.js"
import type { UIState } from "./UISlice.js"

/** Select the full UI state. */
export const selectUI = (state: RootState): UIState => state[SliceName.UI]
