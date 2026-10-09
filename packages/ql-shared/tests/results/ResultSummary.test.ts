import { ResultSummary, type QueryPage } from "@wireio/ql-shared"

import { createResult, createSuccess, SampleColumns, SampleRows } from "../common/resultFixtures.js"

/** A page descriptor. */
const page = (offset: number, returned: number, total: number): QueryPage => ({
  offset: String(offset),
  limit: null,
  returned_rows: String(returned),
  total_rows: String(total),
  has_more: offset + returned < total
})

describe("ResultSummary", () => {
  it("joins parts with the one separator", () => {
    expect(ResultSummary.join(["a", "b", "c"])).toBe("a · b · c")
    expect(ResultSummary.join([])).toBe("")
  })

  it("numbers pages from the window offset", () => {
    expect(ResultSummary.pagePart(page(200, 100, 1_000), 100)).toBe("page 3/10")
    expect(ResultSummary.pagePart(page(0, 0, 0), 100)).toBe("page 1/1")
  })

  it("never reports a page count below the page an offset lands on", () => {
    expect(ResultSummary.pageCount(page(500, 0, 10), 100)).toBe(6)
  })

  it("treats a missing page size (no limit) as one page", () => {
    expect(ResultSummary.pagePart(page(0, 42, 42), null)).toBe("page 1/1")
    expect(ResultSummary.pageNumber(page(0, 0, 0), null)).toBe(1)
  })

  it("describes the row range, total and block", () => {
    expect(ResultSummary.rowsPart(page(100, 25, 125))).toBe("rows 101–125 of 125")
    expect(ResultSummary.rowsPart(page(0, 0, 7))).toBe("rows 0 of 7")
    expect(ResultSummary.totalPart(page(0, 0, 7))).toBe("total 7")
    expect(ResultSummary.blockPart(createResult(SampleColumns, SampleRows).state)).toBe("block 42")
  })

  it("names the scanned / matched counts and the last irreversible block", () => {
    const { stats, state } = createResult(SampleColumns, SampleRows)
    expect(ResultSummary.scannedPart(stats)).toBe(`scanned ${stats.scanned_rows}`)
    expect(ResultSummary.matchedPart({ ...stats, matched_rows: "0" })).toBe("matched 0")
    expect(ResultSummary.irreversiblePart(state)).toBe("LIB 40")
  })

  it("formats server µs and wall ms apart", () => {
    const execution = createSuccess(createResult(SampleColumns, SampleRows))
    expect(ResultSummary.serverTimePart(execution.result.stats)).toBe("1200 µs server")
    expect(ResultSummary.wallTimePart(3)).toBe("3.0 ms wall")
    expect(ResultSummary.elapsedPart(execution)).toBe("1200 µs server · 12.5 ms wall")
  })

  it("labels the sync state", () => {
    const { state } = createResult(SampleColumns, SampleRows)
    expect(ResultSummary.syncedLabel(state)).toBe(ResultSummary.SyncedText)
    expect(ResultSummary.syncedLabel({ ...state, synced: false })).toBe("NOT synced")
  })

  it("describes a page as page · rows · block", () => {
    expect(ResultSummary.describe(createResult(SampleColumns, SampleRows, 30), 3)).toBe("page 1/10 · rows 1–3 of 30 · block 42")
  })
})
