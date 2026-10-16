import { DelimitedText, LogicalType, ResultSelection, ResultView, SelectionFormat } from "@wireio/ql-shared"

import { column, createResult, SampleColumns, SampleRows } from "../common/resultFixtures.js"

describe("ResultSelection", () => {
  const view = ResultView.create(createResult(SampleColumns, SampleRows), { columns: ["name", "note"] })

  it("copies a cell", () => {
    expect(ResultSelection.cell(view, 2, "note", SelectionFormat.tsv)).toBe("tab\\there")
    expect(ResultSelection.cell(view, 1, "note", SelectionFormat.tsv)).toBe("\\N")
    expect(ResultSelection.cell(view, 0, "name", SelectionFormat.json)).toBe("\"alice\"")
  })

  it("copies a row over the projected columns", () => {
    expect(ResultSelection.row(view, 0, SelectionFormat.tsv)).toBe("alice\tfirst")
    expect(ResultSelection.row(view, 1, SelectionFormat.json)).toBe("{\"name\":\"bob\",\"note\":null}")
  })

  it("copies a column", () => {
    expect(ResultSelection.column(view, "name", SelectionFormat.tsv)).toBe("alice\nbob\ncarol")
    expect(ResultSelection.column(view, "name", SelectionFormat.json)).toBe("[\"alice\",\"bob\",\"carol\"]")
  })

  it("copies a range with a TSV header", () => {
    expect(ResultSelection.range(view, { start: 0, end: 2 }, SelectionFormat.tsv)).toBe("name\tnote\nalice\tfirst\nbob\t\\N")
    expect(JSON.parse(ResultSelection.range(view, { start: 1, end: 2 }, SelectionFormat.json))).toEqual([{ name: "bob", note: null }])
  })

  it("escapes tabs, newlines and backslashes (the TSV dialect)", () => {
    expect(DelimitedText.TsvDialect.escape("a\\b\tc\nd\re")).toBe("a\\\\b\\tc\\nd\\re")
  })

  it("rejects an unknown column", () => {
    expect(() => ResultSelection.cell(view, 0, "amount", SelectionFormat.tsv)).toThrow("unknown column amount")
  })
})

describe("DelimitedText", () => {
  const text = column("t", LogicalType.text)

  it("quotes CSV fields only when needed, doubling quotes; NULL is empty", () => {
    expect(DelimitedText.CsvDialect.escape("plain")).toBe("plain")
    expect(DelimitedText.CsvDialect.escape("a,\"b\"")).toBe("\"a,\"\"b\"\"\"")
    expect(DelimitedText.field(text, null, DelimitedText.CsvDialect)).toBe("")
  })

  it("writes canonical field text, records and headers", () => {
    expect(DelimitedText.field(text, "a\tb", DelimitedText.TsvDialect)).toBe("a\\tb")
    expect(DelimitedText.field(text, null, DelimitedText.TsvDialect)).toBe("\\N")
    expect(DelimitedText.record([text, column("n", LogicalType.integer)], { t: "x", n: "5" }, DelimitedText.CsvDialect)).toBe("x,5")
    expect(DelimitedText.header([column("a,b", LogicalType.text)], DelimitedText.CsvDialect)).toBe("\"a,b\"")
  })
})
