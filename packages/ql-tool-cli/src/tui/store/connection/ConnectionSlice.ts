import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { ConnectionProfile, ConnectionProfilesDocument } from "@wireio/ql-shared"

import { clampIndex, moveCursor } from "../../../utils/index.js"
import { SliceName } from "../SliceName.js"

/** The active connection and the saved profiles. */
export interface ConnectionState {
  /** The profile queries run against (null before boot). */
  profile: ConnectionProfile
  /** Saved profiles (`profiles.json`). */
  profiles: ConnectionProfile[]
  /** Name of the default profile, or null. */
  defaultProfile: string
  /** Cursor of the Profiles route. */
  cursor: number
}

/** The initial connection state. */
export const initialConnectionState: ConnectionState = {
  profile: null,
  profiles: [],
  defaultProfile: null,
  cursor: 0
}

/** Connection slice. */
export const ConnectionSlice = createSlice({
  name: SliceName.connection,
  initialState: initialConnectionState,
  reducers: {
    /** Switch the active profile. */
    profileSelected(state, action: PayloadAction<ConnectionProfile>) {
      state.profile = action.payload
    },
    /** `profiles.json` (re)loaded; the cursor is clamped. */
    profilesLoaded(state, action: PayloadAction<ConnectionProfilesDocument>) {
      state.profiles = action.payload.profiles
      state.defaultProfile = action.payload.defaultProfile
      state.cursor = clampIndex(state.cursor, action.payload.profiles.length)
    },
    /** Move the Profiles-route cursor by `delta` (clamped). */
    cursorMoved(state, action: PayloadAction<number>) {
      state.cursor = moveCursor(state.cursor, action.payload, state.profiles.length)
    }
  }
})

/** Connection actions. */
export const ConnectionActions = ConnectionSlice.actions
