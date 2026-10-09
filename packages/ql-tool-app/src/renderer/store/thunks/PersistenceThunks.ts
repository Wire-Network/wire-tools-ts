import type { ConnectionProfile } from "@wireio/ql-shared"

import { IPCChannel } from "../../../common/index.js"
import { ConnectionsActions } from "../connections/ConnectionsSlice.js"
import { History, HistoryActions } from "../history/HistorySlice.js"
import { SavedActions } from "../saved/SavedSlice.js"
import type { AppThunk } from "../Store.js"
import { selectActiveEditorTab } from "../workspace/WorkspaceSlice.js"
import { resetCatalog } from "./CatalogThunks.js"
import { guarded } from "./common/index.js"

/**
 * Load profiles.json (and reset the catalog when the active profile changed).
 *
 * @returns The thunk.
 */
export function loadProfiles(): AppThunk {
  return guarded("Loading connections", async (dispatch, getState, services) => {
    const previous = getState().connections.activeProfileName
    dispatch(ConnectionsActions.profilesLoaded(await services.bridge.invoke(IPCChannel.profilesList, undefined)))
    if (getState().connections.activeProfileName !== previous) await dispatch(resetCatalog())
  })
}

/**
 * Add or replace a profile.
 *
 * @param profile - The profile.
 * @returns The thunk.
 */
export function saveProfile(profile: ConnectionProfile): AppThunk {
  return guarded("Saving the connection", async (dispatch, _getState, services) => {
    dispatch(ConnectionsActions.profilesLoaded(await services.bridge.invoke(IPCChannel.profilesUpsert, profile)))
    await dispatch(resetCatalog())
  })
}

/**
 * Remove a profile.
 *
 * @param name - Profile name.
 * @returns The thunk.
 */
export function removeProfile(name: string): AppThunk {
  return guarded("Removing the connection", async (dispatch, _getState, services) => {
    dispatch(ConnectionsActions.profilesLoaded(await services.bridge.invoke(IPCChannel.profilesRemove, { name })))
    await dispatch(resetCatalog())
  })
}

/**
 * Make a profile the default.
 *
 * @param name - Profile name.
 * @returns The thunk.
 */
export function setDefaultProfile(name: string): AppThunk {
  return guarded("Setting the default connection", async (dispatch, _getState, services) => {
    dispatch(ConnectionsActions.profilesLoaded(await services.bridge.invoke(IPCChannel.profilesSetDefault, { name })))
  })
}

/**
 * Activate a profile and reset the catalog to its owners.
 *
 * @param name - Profile name.
 * @returns The thunk.
 */
export function selectProfile(name: string): AppThunk {
  return async dispatch => {
    dispatch(ConnectionsActions.profileSelected(name))
    await dispatch(resetCatalog())
  }
}

/**
 * Load the history drawer (current search applied).
 *
 * @returns The thunk.
 */
export function loadHistory(): AppThunk {
  return guarded("Loading history", async (dispatch, getState, services) => {
    const { search } = getState().history
    dispatch(
      HistoryActions.historyLoaded(
        await services.bridge.invoke(IPCChannel.historyList, { limit: History.ListLimit, search })
      )
    )
  })
}

/**
 * Truncate the history file.
 *
 * @returns The thunk.
 */
export function clearHistory(): AppThunk {
  return guarded("Clearing history", async (dispatch, _getState, services) => {
    await services.bridge.invoke(IPCChannel.historyClear, undefined)
    dispatch(HistoryActions.historyLoaded([]))
  })
}

/**
 * Load the saved queries.
 *
 * @returns The thunk.
 */
export function loadSaved(): AppThunk {
  return guarded("Loading saved queries", async (dispatch, _getState, services) => {
    dispatch(SavedActions.savedLoaded(await services.bridge.invoke(IPCChannel.savedList, undefined)))
  })
}

/**
 * Save the focused editor's SQL under a name.
 *
 * @param name - Display name.
 * @returns The thunk.
 */
export function saveCurrentQuery(name: string): AppThunk {
  return guarded("Saving the query", async (dispatch, getState, services) => {
    const { text } = selectActiveEditorTab(getState().workspace)
    dispatch(SavedActions.savedLoaded(await services.bridge.invoke(IPCChannel.savedUpsert, { name, query: text })))
  })
}

/**
 * Remove a saved query.
 *
 * @param id - Saved-query id.
 * @returns The thunk.
 */
export function removeSaved(id: string): AppThunk {
  return guarded("Removing the saved query", async (dispatch, _getState, services) => {
    dispatch(SavedActions.savedLoaded(await services.bridge.invoke(IPCChannel.savedRemove, { name: id })))
  })
}
