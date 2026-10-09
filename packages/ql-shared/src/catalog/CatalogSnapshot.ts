import { NestedError } from "@wireio/shared"

import type { LogicalType } from "../protocol/index.js"
import type { CatalogFieldRole } from "./CatalogNodeKind.js"

/** One field: ABI type always; logical type once a describe has run (value fields only), else null. */
export interface CatalogField {
  /** Query path (`key.id` for key fields, the field name for value fields). */
  path: string
  /** Key or value. */
  role: CatalogFieldRole
  /** ABI type name. */
  abiType: string
  /** Engine logical type after a describe; null before. */
  logicalType: LogicalType
}

/** One table in the catalog. */
export interface CatalogTable {
  /** Table name. */
  name: string
  /** ABI row struct type. */
  rowType: string
  /** Key fields then value fields. */
  fields: CatalogField[]
  /** Whether a describe filled the value fields' logical types. */
  described: boolean
}

/** One owner account in the catalog. */
export interface CatalogOwner {
  /** Owner account. */
  account: string
  /** Tables from the owner's ABI (empty until loaded). */
  tables: CatalogTable[]
  /** Whether the ABI was loaded. */
  loaded: boolean
}

/** Serializable (structured-clone / JSON) catalog state — feeds completion, the TUI tree and the GUI navigator. */
export interface CatalogSnapshot {
  /** Endpoint the catalog was read from. */
  endpoint: string
  /** Owners in configured order. */
  owners: CatalogOwner[]
  /** ISO-8601 time of the last change. */
  capturedAt: string
}

/** Snapshot helpers. */
export namespace CatalogSnapshot {
  /**
   * A snapshot with every owner unloaded.
   *
   * @param endpoint - The endpoint.
   * @param owners - Owner accounts.
   * @returns The empty snapshot.
   */
  export function empty(endpoint: string, owners: string[]): CatalogSnapshot {
    return {
      endpoint,
      owners: owners.map(account => ({ account, tables: [], loaded: false })),
      capturedAt: new Date().toISOString()
    }
  }

  /**
   * The owner `owner`.
   *
   * @param snapshot - The snapshot.
   * @param owner - Owner account.
   * @returns The owner.
   * @throws NestedError `owner <owner> is not in the catalog` (context: the owner, the
   *   catalog's owners and endpoint) — a caller-supplied name, so a CLI maps it to a usage error.
   */
  export function findOwner(snapshot: CatalogSnapshot, owner: string): CatalogOwner {
    const found = snapshot.owners.find(candidate => candidate.account === owner)
    if (found == null) {
      throw new NestedError(`owner ${owner} is not in the catalog`, {
        context: { owner, owners: snapshot.owners.map(candidate => candidate.account), endpoint: snapshot.endpoint }
      })
    }
    return found
  }

  /**
   * The table `owner.table`, or undefined when not in the snapshot.
   *
   * @param snapshot - The snapshot.
   * @param owner - Owner account.
   * @param table - Table name.
   * @returns The table, if present.
   */
  export function lookupTable(
    snapshot: CatalogSnapshot,
    owner: string,
    table: string
  ): CatalogTable {
    return snapshot.owners
      .find(candidate => candidate.account === owner)
      ?.tables.find(candidate => candidate.name === table)
  }

  /**
   * The table `owner.table`.
   *
   * @param snapshot - The snapshot.
   * @param owner - Owner account.
   * @param table - Table name.
   * @returns The table.
   * @throws NestedError when the owner or table is not in the snapshot.
   */
  export function findTable(
    snapshot: CatalogSnapshot,
    owner: string,
    table: string
  ): CatalogTable {
    const found = lookupTable(snapshot, owner, table)
    if (found == null) {
      throw new NestedError(`table ${owner}.${table} is not in the catalog`, {
        context: { owner, table, endpoint: snapshot.endpoint }
      })
    }
    return found
  }
}
