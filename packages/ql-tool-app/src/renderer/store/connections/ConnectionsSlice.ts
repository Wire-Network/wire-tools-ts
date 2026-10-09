import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import { ConnectionProfilesDocument, type ConnectionProfile } from "@wireio/ql-shared"

import { QueryPortStatus } from "../../query/index.js"
import { SliceName } from "../SliceName.js"

/** Connection profiles + the active one + the query-port status. */
export interface ConnectionsState {
  /** profiles.json as main last returned it. */
  document: ConnectionProfilesDocument
  /** Name of the profile queries run against (null = none chosen). */
  activeProfileName: string
  /** The renderer's query-port status. */
  portStatus: QueryPortStatus
}

/**
 * The initial connections state.
 *
 * @returns Empty document, no active profile, connecting.
 */
export function createConnectionsInitialState(): ConnectionsState {
  return {
    document: ConnectionProfilesDocument.empty(),
    activeProfileName: null,
    portStatus: QueryPortStatus.connecting
  }
}

/**
 * The profile to keep active after a reload: the current one if still present,
 * else the default, else the first, else none.
 *
 * @param document - The new document.
 * @param current - The current active name.
 * @returns The active name (undefined for none).
 */
export function resolveActiveProfileName(document: ConnectionProfilesDocument, current: string): string {
  const names = document.profiles.map(profile => profile.name)
  return [current, document.defaultProfile, names[0]].find(name => name != null && names.includes(name))
}

/** Connections slice. */
export const ConnectionsSlice = createSlice({
  name: SliceName.connections,
  initialState: createConnectionsInitialState(),
  reducers: {
    /** profiles.json (re)loaded. */
    profilesLoaded(state, action: PayloadAction<ConnectionProfilesDocument>) {
      state.document = action.payload
      state.activeProfileName = resolveActiveProfileName(action.payload, state.activeProfileName)
    },
    /** The user picked a profile. */
    profileSelected(state, action: PayloadAction<string>) {
      state.activeProfileName = action.payload
    },
    /** The query port changed state. */
    portStatusChanged(state, action: PayloadAction<QueryPortStatus>) {
      state.portStatus = action.payload
    }
  }
})

/** Connections actions. */
export const ConnectionsActions = ConnectionsSlice.actions

/**
 * The profile named `name` (what a result tab ran against).
 *
 * @param state - Connections state.
 * @param name - Profile name.
 * @returns The profile, or undefined when no profile has that name.
 */
export function selectProfileNamed(state: ConnectionsState, name: string): ConnectionProfile {
  return state.document.profiles.find(profile => profile.name === name)
}

/**
 * The active profile.
 *
 * @param state - Connections state.
 * @returns The profile, or undefined.
 */
export function selectActiveProfile(state: ConnectionsState): ConnectionProfile {
  return selectProfileNamed(state, state.activeProfileName)
}
