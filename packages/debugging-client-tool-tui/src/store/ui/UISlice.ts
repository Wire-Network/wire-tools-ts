import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { DefaultStatus, SliceName } from "../StoreTypes.js"

/** UI-level ephemera shown in the header. */
export interface UIState {
  /** Single-line status message rendered beside the cluster path. */
  status: string
}

const initialState: UIState = { status: DefaultStatus }

/** UI slice — owns header status text. */
export const uiSlice = createSlice({
  name: SliceName.UI,
  initialState,
  reducers: {
    /** Replace the status string — clamped to a single line by convention. */
    setStatus: (state, action: PayloadAction<string>) => {
      state.status = action.payload
    }
  }
})

export const { setStatus } = uiSlice.actions
