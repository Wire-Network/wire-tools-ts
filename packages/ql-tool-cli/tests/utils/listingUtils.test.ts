import { ListingColumnSeparator, listingLine, singleLine, WhitespacePattern, ListingEmptyCell } from "@wireio/ql-tool-cli/utils/index.js"

describe("listingUtils", () => {
  it("puts query text on one line", () => {
    expect(singleLine("SELECT *\n  FROM\ta.b")).toBe("SELECT * FROM a.b")
    expect(singleLine("")).toBe("")
    expect("a  b\nc".replace(WhitespacePattern, "_")).toBe("a_b_c")
  })

  it("joins listing cells with the tab separator", () => {
    expect(ListingColumnSeparator).toBe("\t")
    expect(listingLine(["a", 1, "c"])).toBe("a\t1\tc")
    expect(listingLine([])).toBe("")
  })
})

describe("ListingEmptyCell", () => {
  it("is the one placeholder of an absent listing cell", () => {
    expect(ListingEmptyCell).toBe("-")
    expect(listingLine(["a", ListingEmptyCell])).toBe(`a${ListingColumnSeparator}-`)
  })
})
