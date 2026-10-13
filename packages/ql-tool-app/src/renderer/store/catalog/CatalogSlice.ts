import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

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
  return { snapshot: null, loadingOwners: [], error: null }
}

/** Catalog slice. */
export const CatalogSlice = createSlice({
  name: SliceName.catalog,
  initialState: createCatalogInitialState(),
  reducers: {
    /** A profile was (re)selected: start from its unloaded owners. */
    catalogReset(state, action: PayloadAction<CatalogSnapshot>) {
      state.snapshot = action.payload
      state.loadingOwners = []
      state.error = null
    },
    /** An owner's ABI load started. */
    ownerLoading(state, action: PayloadAction<string>) {
      if (!state.loadingOwners.includes(action.payload)) state.loadingOwners.push(action.payload)
    },
    /** A load / describe answered. */
    snapshotLoaded(state, action: PayloadAction<CatalogLoaded>) {
      state.snapshot = action.payload.snapshot
      state.loadingOwners = state.loadingOwners.filter(owner => owner !== action.payload.owner)
      state.error = null
    },
    /** A load / describe failed. */
    catalogFailed(state, action: PayloadAction<CatalogFailed>) {
      state.loadingOwners = state.loadingOwners.filter(owner => owner !== action.payload.owner)
      state.error = action.payload.message
    }
  }
})

/** Catalog actions. */
export const CatalogActions = CatalogSlice.actions
