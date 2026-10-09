import { CatalogNodeKind, CatalogSnapshot } from "@wireio/ql-shared"

describe("CatalogSnapshot", () => {
  it("starts with every owner unloaded", () => {
    const snapshot = CatalogSnapshot.empty("http://x", ["a", "b"])
    expect(snapshot.owners).toEqual([
      { account: "a", tables: [], loaded: false },
      { account: "b", tables: [], loaded: false }
    ])
    expect(snapshot.endpoint).toBe("http://x")
    expect(Number.isNaN(Date.parse(snapshot.capturedAt))).toBe(false)
  })

  it("finds tables and throws on a miss", () => {
    const table = { name: "t", rowType: "r", fields: [], described: false },
      snapshot: CatalogSnapshot = { endpoint: "e", capturedAt: "", owners: [{ account: "a", loaded: true, tables: [table] }] }
    expect(CatalogSnapshot.findTable(snapshot, "a", "t")).toBe(table)
    expect(CatalogSnapshot.lookupTable(snapshot, "a", "missing")).toBeUndefined()
    expect(CatalogSnapshot.lookupTable(snapshot, "nobody", "t")).toBeUndefined()
    expect(() => CatalogSnapshot.findTable(snapshot, "a", "missing")).toThrow("not in the catalog")
  })

  it("finds owners and throws a message naming the missing owner", () => {
    const owner = { account: "a", loaded: true, tables: [] },
      snapshot: CatalogSnapshot = { endpoint: "e", capturedAt: "", owners: [owner] }
    expect(CatalogSnapshot.findOwner(snapshot, "a")).toBe(owner)
    expect(() => CatalogSnapshot.findOwner(snapshot, "nobody")).toThrow("owner nobody is not in the catalog")
  })

  it("names the navigator node kinds", () => {
    expect(Object.values(CatalogNodeKind)).toEqual(["owner", "table", "field"])
  })
})
