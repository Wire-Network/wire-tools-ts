import { ResultSearch, ResultView } from "@wireio/ql-shared"

import { createResult, SampleColumns, SampleRows } from "../common/resultFixtures.js"

describe("ResultSearch", () => {
  const view = ResultView.create(createResult(SampleColumns, SampleRows))

  it("finds case-insensitive hits over display text, row-major", () => {
    expect(ResultSearch.find(view, "SYS")).toEqual([
      { rowIndex: 0, column: "balance" },
      { rowIndex: 1, column: "balance" },
      { rowIndex: 2, column: "balance" }
    ])
    expect(ResultSearch.find(view, "null")).toEqual([{ rowIndex: 1, column: "note" }])
  })

  it("returns nothing for empty text or no match", () => {
    expect(ResultSearch.find(view, "")).toEqual([])
    expect(ResultSearch.find(view, "zzz")).toEqual([])
  })
})
