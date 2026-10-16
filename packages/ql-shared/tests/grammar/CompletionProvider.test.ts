import {
  CatalogFieldRole,
  CatalogSnapshot,
  CompletionKind,
  CompletionProvider,
  LogicalType
} from "@wireio/ql-shared"

const snapshot: CatalogSnapshot = {
  endpoint: "http://x",
  capturedAt: "2026-10-07T00:00:00.000Z",
  owners: [
    {
      account: "sysio.opreg",
      loaded: true,
      tables: [
        {
          name: "operators",
          rowType: "operator_row",
          described: true,
          fields: [
            { path: "key.account", role: CatalogFieldRole.key, abiType: "name", logicalType: null },
            { path: "status", role: CatalogFieldRole.value, abiType: "uint8", logicalType: LogicalType.enumeration }
          ]
        }
      ]
    },
    { account: "sample", loaded: false, tables: [] }
  ]
}

const labels = (text: string, offset: number = text.length) =>
  CompletionProvider.candidates(text, offset, snapshot).map(candidate => [candidate.kind, candidate.label, candidate.insertText])

describe("CompletionProvider", () => {
  it("offers owners (quoted when needed) and qualified tables after FROM", () => {
    const offered = labels("SELECT * FROM ")
    expect(offered).toContainEqual([CompletionKind.owner, "sysio.opreg", "\"sysio.opreg\""])
    expect(offered).toContainEqual([CompletionKind.owner, "sample", "sample"])
    expect(offered).toContainEqual([CompletionKind.table, "sysio.opreg.operators", "\"sysio.opreg\".operators"])
  })

  it("offers an owner's tables after `owner.`", () => {
    expect(labels("SELECT * FROM \"sysio.opreg\".")).toEqual([[CompletionKind.table, "operators", "operators"]])
  })

  it("offers owners as strings after OWNER and after a comma in the owner list", () => {
    expect(labels("SELECT * FROM operators OWNER ")).toContainEqual([CompletionKind.owner, "sysio.opreg", "'sysio.opreg'"])
    expect(labels("SELECT * FROM operators OWNER 'a', ")).toContainEqual([CompletionKind.owner, "sample", "'sample'"])
  })

  it("offers fields, aggregates and keywords in expression clauses, filtered by prefix", () => {
    const select = labels("SELECT st FROM \"sysio.opreg\".operators", "SELECT st".length)
    expect(select).toEqual([[CompletionKind.field, "status", "status"]])
    const where = CompletionProvider.candidates("SELECT * FROM operators OWNER 'sysio.opreg' WHERE ", 51, snapshot)
    expect(where.map(candidate => candidate.label)).toEqual(expect.arrayContaining(["key.account", "status", "COUNT", "AND"]))
    expect(where.find(candidate => candidate.label === "status").detail).toBe(LogicalType.enumeration)
    expect(where.find(candidate => candidate.label === "COUNT").insertText).toBe("COUNT(")
  })

  it("offers keywords at the start and handles an empty snapshot", () => {
    expect(labels("SEL")).toEqual([[CompletionKind.keyword, "SELECT", "SELECT"]])
    expect(CompletionProvider.candidates("", 0, CatalogSnapshot.empty("http://x", [])).length).toBeGreaterThan(0)
    expect(CompletionProvider.candidates("SELECT x FROM ", 14, CatalogSnapshot.empty("http://x", []))).toEqual([])
  })

  it("offers no fields for an unknown table", () => {
    expect(labels("SELECT  FROM nowhere.none", 7).filter(([kind]) => kind === CompletionKind.field)).toEqual([])
  })

  it("reads a quoted-identifier owner in the OWNER list", () => {
    const fields = labels("SELECT  FROM operators OWNER \"sysio.opreg\"", 7).filter(([kind]) => kind === CompletionKind.field)
    expect(fields.map(([, label]) => label)).toEqual(["key.account", "status"])
  })

  it("ends the OWNER list at the next clause keyword", () => {
    const text = "SELECT  FROM operators OWNER sample WHERE 'sysio.opreg' = status"
    expect(labels(text, 7).filter(([kind]) => kind === CompletionKind.field)).toEqual([])
  })
})
