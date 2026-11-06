import { CatalogSnapshot, ConnectionProfile } from "@wireio/ql-shared"

import { CatalogActions } from "../catalog/CatalogSlice.js"
import { selectActiveProfile } from "../connections/ConnectionsSlice.js"
import type { AppDispatch, AppThunk } from "../Store.js"
import { guarded, type GuardedFailure, type GuardedFailureReporter } from "./common/index.js"

/**
 * The reporter of a failed owner load / describe: the navigator shows the message.
 *
 * @param owner - The owner that was loading (null for a describe).
 * @returns The reporter.
 */
function reportCatalogFailure(owner: string): GuardedFailureReporter {
  return (dispatch: AppDispatch, failure: GuardedFailure) => dispatch(CatalogActions.catalogFailed({ owner, message: failure.message }))
}

/**
 * Start the navigator from the active profile's (unloaded) owners.
 *
 * @returns The thunk.
 */
export function resetCatalog(): AppThunk {
  return async (dispatch, getState) => {
    const profile = selectActiveProfile(getState().connections)
    dispatch(
      CatalogActions.catalogReset(
        profile == null ? null : CatalogSnapshot.empty(profile.endpoint, ConnectionProfile.resolveOwners(profile))
      )
    )
  }
}

/**
 * Load an owner's ABI through the query host.
 *
 * @param owner - Owner account.
 * @returns The thunk.
 */
export function loadOwner(owner: string): AppThunk {
  return async (dispatch, getState, services) => {
    const profile = selectActiveProfile(getState().connections)
    if (profile == null) return
    dispatch(CatalogActions.ownerLoading(owner))
    await dispatch(
      guarded(
        `Loading ${owner}`,
        async () => {
          const snapshot = await services.queryPort.loadOwner(services.createRequestId(), profile, owner)
          dispatch(CatalogActions.snapshotLoaded({ owner, snapshot }))
        },
        reportCatalogFailure(owner)
      )
    )
  }
}

/**
 * LIMIT 0 describe of a table (fills the value fields' logical types).
 *
 * @param owner - Owner account.
 * @param table - Table name.
 * @returns The thunk.
 */
export function describeTable(owner: string, table: string): AppThunk {
  return async (dispatch, getState, services) => {
    const profile = selectActiveProfile(getState().connections)
    if (profile == null) return
    await dispatch(
      guarded(
        `Describing ${owner}.${table}`,
        async () => {
          const snapshot = await services.queryPort.describe(services.createRequestId(), profile, owner, table)
          dispatch(CatalogActions.snapshotLoaded({ owner: null, snapshot }))
        },
        reportCatalogFailure(null)
      )
    )
  }
}

/**
 * F5 / Refresh Schema: reload every already-loaded owner's ABI.
 *
 * @returns The thunk.
 */
export function loadCatalogOwners(): AppThunk {
  return async (dispatch, getState) => {
    const loaded = getState().catalog.snapshot?.owners.filter(owner => owner.loaded) ?? []
    await Promise.all(loaded.map(owner => dispatch(loadOwner(owner.account))))
  }
}
