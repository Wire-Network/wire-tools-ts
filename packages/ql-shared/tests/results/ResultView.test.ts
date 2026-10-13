import { CellFormatter, ResultView, SortDirection } from "@wireio/ql-shared"

import { createResult, SampleColumns, SampleRows } from "../common/resultFixtures.js"

const result = createResult(SampleColumns, SampleRows),
  names = (view: ResultView) => view.rows(view.fullRange()).map(row => row.name)

describe("ResultView", () => {
  it("defaults to every row and column in engine order", () => {
    const view = ResultView.create(result)
    expect(view.rowCount).toBe(3)
    expect(view.columns.map(column => column.name)).toEqual(["name", "amount", "balance", "note"])
    expect(view.row(0).name).toBe("alice")
    expect(view.result).toBe(result)
  })

  it("sorts typed (integers numerically) in both directions", () => {
    expect(names(ResultView.create(result, { sorts: [{ column: "amount", direction: SortDirection.asc }] }))).toEqual(["bob", "alice", "carol"])
    expect(names(ResultView.create(result, { sorts: [{ column: "amount", direction: SortDirection.desc }] }))).toEqual(["carol", "alice", "bob"])
  })

  it("keeps NULL last in either direction and applies multi-key sorts", () => {
    expect(names(ResultView.create(result, { sorts: [{ column: "note", direction: SortDirection.desc }] }))).toEqual(["carol", "alice", "bob"])
    expect(names(ResultView.create(result, { sorts: [{ column: "note", direction: SortDirection.asc }] }))).toEqual(["alice", "carol", "bob"])
    const tied = createResult(SampleColumns, [SampleRows[0], { ...SampleRows[1], amount: "10" }])
    expect(
      names(ResultView.create(tied, { sorts: [{ column: "amount", direction: SortDirection.asc }, { column: "name", direction: SortDirection.desc }] }))
    ).toEqual(["bob", "alice"])
  })

  it("filters by case-insensitive display text and projects columns", () => {
    const view = ResultView.create(result, { filters: [{ column: "name", text: "AL" }], columns: ["amount", "name"] })
    expect(names(view)).toEqual(["alice"])
    expect(view.columns.map(column => column.name)).toEqual(["amount", "name"])
    expect(view.projectRow(view.row(0))).toEqual({ amount: "10", name: "alice" })
    expect(view.config.columns).toEqual(["amount", "name"])
  })

  it("clamps row ranges", () => {
    const view = ResultView.create(result)
    expect(view.rows({ start: -5, end: 100 })).toHaveLength(3)
    expect(view.rows({ start: 2, end: 1 })).toEqual([])
  })

  it("asserts column names", () => {
    expect(() => ResultView.create(result, { columns: ["missing"] })).toThrow("unknown column missing")
    expect(() => ResultView.create(result, { sorts: [{ column: "x", direction: SortDirection.asc }] })).toThrow()
    expect(() => ResultView.create(result, { filters: [{ column: "y", text: "" }] })).toThrow()
  })

  it("computes each sort key once per row, not per comparison", () => {
    const spy = jest.spyOn(CellFormatter, "sortKey")
    try {
      ResultView.create(createResult(SampleColumns, SampleRows), { sorts: [{ column: "amount", direction: SortDirection.desc }] })
      expect(spy).toHaveBeenCalledTimes(SampleRows.length)
    } finally {
      spy.mockRestore()
    }
  })

  it("assertColumn finds a column or names the known ones", () => {
    expect(ResultView.assertColumn(SampleColumns, "amount").logical_type).toBe(SampleColumns[1].logical_type)
    expect(() => ResultView.assertColumn(SampleColumns, "missing")).toThrow("unknown column missing")
  })
})
