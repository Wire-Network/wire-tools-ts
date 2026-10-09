import { CatalogFieldRole, LogicalType, type CatalogSnapshot } from "@wireio/ql-shared"

import { ConnectionFixtures } from "./ConnectionFixtures.js"

/** Catalog snapshots for completion / hover / navigator tests. */
export namespace CatalogFixtures {
  /**
   * `sample` loaded with `positions(key.id, name, amount)`; `name` described.
   *
   * @returns The snapshot.
   */
  export function loaded(): CatalogSnapshot {
    return {
      endpoint: ConnectionFixtures.Endpoint,
      capturedAt: "2026-10-07T12:00:00.000Z",
      owners: [
        {
          account: "sample",
          loaded: true,
          tables: [
            {
              name: "positions",
              rowType: "position",
              described: true,
              fields: [
                { path: "key.id", role: CatalogFieldRole.key, abiType: "uint64", logicalType: null },
                { path: "name", role: CatalogFieldRole.value, abiType: "name", logicalType: LogicalType.text },
                { path: "amount", role: CatalogFieldRole.value, abiType: "uint64", logicalType: null }
              ]
            }
          ]
        },
        { account: "other", loaded: false, tables: [] }
      ]
    }
  }
}
