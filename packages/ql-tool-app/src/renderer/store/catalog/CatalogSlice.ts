import { createSlice, type Draft, type PayloadAction } from "@reduxjs/toolkit"

import { CatalogSnapshot } from "@wireio/ql-shared"

import { SliceName } from "../SliceName.js"

/** The schema navigator's catalog. */
export interface CatalogState {
  /** Latest snapshot from the query host (null before the first load). */
  snapshot: CatalogSnapshot
  /** Owners whose ABI is loading. */
  loadingOwners: string[]
  /** Last catalog error (null = none). */
  error: string
  /**
   * Bumped by every `catalogReset`. The navigator keys its tree on it, so a
   * reset catalog's owners start collapsed instead of expanded-but-unloaded.
   */
  generation: number
}

/** An owner/table load finished with a snapshot. */
export interface CatalogLoaded {
  /** The owner that was loading (null for a describe). */
  owner: string
  /** The new snapshot. */
  snapshot: CatalogSnapshot
}

/** A catalog request failed. */
export interface CatalogFailed {
  /** The owner that was loading (null for a describe). */
  owner: string
  /** The message. */
  message: string
}

/**
 * The initial catalog state.
 *
 * @returns Nothing loaded.
 */
export function createCatalogInitialState(): CatalogState {
  return { snapshot: null, loadingOwners: [], error: null, generation: 0 }
}

/** Catalog slice. */
export const CatalogSlice = createSlice({
  name: SliceName.catalog,
  initialState: createCatalogInitialState(),
  reducers: {
    /** A profile was (re)selected: start from its unloaded owners. */
    catalogReset(state: Draft<CatalogState>, action: PayloadAction<CatalogSnapshot>) {
      state.snapshot = action.payload
      state.loadingOwners = []
      state.error = null
      state.generation += 1
    },
    /** An owner's ABI load started. */
    ownerLoading(state: Draft<CatalogState>, action: PayloadAction<string>) {
      if (!state.loadingOwners.includes(action.payload)) state.loadingOwners.push(action.payload)
    },
    /** A load / describe answered. */
    snapshotLoaded(state: Draft<CatalogState>, action: PayloadAction<CatalogLoaded>) {
      state.snapshot = action.payload.snapshot
      state.loadingOwners = state.loadingOwners.filter(owner => owner !== action.payload.owner)
      state.error = null
    },
    /** A load / describe failed. */
    catalogFailed(state: Draft<CatalogState>, action: PayloadAction<CatalogFailed>) {
      state.loadingOwners = state.loadingOwners.filter(owner => owner !== action.payload.owner)
      state.error = action.payload.message
    },
    /** The user closed the error. */
    errorDismissed(state: Draft<CatalogState>) {
      state.error = null
    }
  }
})

/** Catalog actions. */
export const CatalogActions = CatalogSlice.actions
