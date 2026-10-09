import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { xor } from "lodash"

import { CatalogNodeKind, type CatalogSnapshot } from "@wireio/ql-shared"

import { moveCursor } from "../../../utils/index.js"
import { SliceName } from "../SliceName.js"

/** One visible row of the schema tree. */
export interface CatalogTreeRow {
  /** Node kind. */
  kind: CatalogNodeKind
  /** Stable key (`owner`, `owner/table`, `owner/table/field`). */
  key: string
  /** Display label. */
  label: string
  /** Indent depth (0 owners, 1 tables, 2 fields). */
  depth: number
  /** Owner account. */
  owner: string
  /** Table name (tables and fields). */
  table?: string
}

/** The schema browser state. */
export interface CatalogState {
  /** Latest catalog snapshot (null before boot). */
  snapshot: CatalogSnapshot
  /** Owners still loading. */
  loading: boolean
  /** Last load failure message (null when none). */
  error: string
  /** Cursor over the visible tree rows. */
  cursor: number
  /** Expanded node keys. */
  expanded: string[]
}

/** The initial catalog state. */
export const initialCatalogState: CatalogState = {
  snapshot: null,
  loading: false,
  error: null,
  cursor: 0,
  expanded: []
}

/** Key separator of tree nodes. */
const KeySeparator = "/"

/** Catalog derivations (pure). */
export namespace CatalogState {
  /**
   * The visible tree: owners, the tables of expanded owners, the fields of expanded tables.
   *
   * @param state - Catalog state.
   * @returns The rows in display order.
   */
  export function treeRows(state: CatalogState): CatalogTreeRow[] {
    const expanded = new Set(state.expanded)
    return (state.snapshot?.owners ?? []).flatMap(owner => [
      { kind: CatalogNodeKind.owner, key: owner.account, label: owner.account, depth: 0, owner: owner.account },
      ...(expanded.has(owner.account)
        ? owner.tables.flatMap(table => {
            const tableKey = [owner.account, table.name].join(KeySeparator)
            return [
              { kind: CatalogNodeKind.table, key: tableKey, label: table.name, depth: 1, owner: owner.account, table: table.name },
              ...(expanded.has(tableKey)
                ? table.fields.map(field => ({
                    kind: CatalogNodeKind.field,
                    key: [tableKey, field.path].join(KeySeparator),
                    label: `${field.path}: ${field.logicalType ?? field.abiType}`,
                    depth: 2,
                    owner: owner.account,
                    table: table.name
                  }))
                : [])
            ]
          })
        : [])
    ])
  }
}

/** Catalog slice. */
export const CatalogSlice = createSlice({
  name: SliceName.catalog,
  initialState: initialCatalogState,
  reducers: {
    /** Loading owners began. */
    loadStarted(state) {
      state.loading = true
      state.error = null
    },
    /** A new snapshot arrived. */
    snapshotLoaded(state, action: PayloadAction<CatalogSnapshot>) {
      state.snapshot = action.payload
    },
    /** Loading finished (successfully or not). */
    loadFinished(state, action: PayloadAction<string>) {
      state.loading = false
      state.error = action.payload
    },
    /** Expand / collapse a node. */
    nodeToggled(state, action: PayloadAction<string>) {
      state.expanded = xor(state.expanded, [action.payload])
    },
    /** Move the tree cursor (clamped by the visible row count). */
    cursorMoved(state, action: PayloadAction<number>) {
      state.cursor = moveCursor(state.cursor, action.payload, CatalogState.treeRows(state).length)
    }
  }
})

/** Catalog actions. */
export const CatalogActions = CatalogSlice.actions
