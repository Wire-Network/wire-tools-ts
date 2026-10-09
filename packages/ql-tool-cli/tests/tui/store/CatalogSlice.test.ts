import { CatalogFieldRole, CatalogNodeKind, CatalogSnapshot, LogicalType } from "@wireio/ql-shared"

import { CatalogActions, CatalogSlice, CatalogState, initialCatalogState } from "@wireio/ql-tool-cli/tui/index.js"

const snapshot: CatalogSnapshot = {
  endpoint: "http://e.example",
  capturedAt: new Date().toISOString(),
  owners: [
    {
      account: "sample",
      loaded: true,
      tables: [
        {
          name: "positions",
          rowType: "position",
          described: true,
          fields: [{ path: "name", role: CatalogFieldRole.value, abiType: "string", logicalType: LogicalType.text }]
        }
      ]
    },
    { account: "other", loaded: false, tables: [] }
  ]
}

const reduce = CatalogSlice.reducer

describe("CatalogSlice", () => {
  it("lists owners, then expanded tables, then expanded fields", () => {
    const loaded = reduce(initialCatalogState, CatalogActions.snapshotLoaded(snapshot))
    expect(CatalogState.treeRows(loaded).map(row => row.key)).toEqual(["sample", "other"])
    const owner = reduce(loaded, CatalogActions.nodeToggled("sample")),
      table = reduce(owner, CatalogActions.nodeToggled("sample/positions"))
    expect(CatalogState.treeRows(table).map(row => [row.kind, row.label, row.depth])).toEqual([
      [CatalogNodeKind.owner, "sample", 0],
      [CatalogNodeKind.table, "positions", 1],
      [CatalogNodeKind.field, "name: text", 2],
      [CatalogNodeKind.owner, "other", 0]
    ])
    expect(CatalogState.treeRows(reduce(table, CatalogActions.nodeToggled("sample")))).toHaveLength(2)
  })

  it("tracks loading / errors and clamps the cursor", () => {
    const started = reduce({ ...initialCatalogState, error: "old" }, CatalogActions.loadStarted())
    expect(started).toMatchObject({ loading: true, error: null })
    expect(reduce(started, CatalogActions.loadFinished("could not load: x"))).toMatchObject({ loading: false, error: "could not load: x" })
    const loaded = reduce(initialCatalogState, CatalogActions.snapshotLoaded(snapshot))
    expect(reduce(loaded, CatalogActions.cursorMoved(10)).cursor).toBe(1)
    expect(CatalogState.treeRows(initialCatalogState)).toEqual([])
  })

  it("toggling a node twice collapses it again", () => {
    const loaded = reduce(initialCatalogState, CatalogActions.snapshotLoaded(snapshot)),
      twice = reduce(reduce(loaded, CatalogActions.nodeToggled("other")), CatalogActions.nodeToggled("other"))
    expect(twice.expanded).toEqual([])
    expect(reduce(loaded, CatalogActions.cursorMoved(9)).cursor).toBe(1)
  })
})
