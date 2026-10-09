import {
  AssetCellSchema,
  CellAlignment,
  CellFormatMode,
  CellFormatter,
  createCellFormatDefaultOptions,
  LogicalType
} from "@wireio/ql-shared"

import { cell, column } from "../common/resultFixtures.js"

const canonical = { mode: CellFormatMode.canonical }

describe("CellFormatter.format", () => {
  it.each([
    [LogicalType.integer, "340282366920938463463374607431768211455", "340282366920938463463374607431768211455"],
    [LogicalType.decimal, "-10.25", "-10.25"],
    [LogicalType.boolean, true, "true"],
    [LogicalType.text, "alice", "alice"],
    [LogicalType.enumeration, "MESSAGE_STATUS_READY", "MESSAGE_STATUS_READY"],
    [LogicalType.time, "2023-11-14T22:13:20.123", "2023-11-14T22:13:20.123"],
    [LogicalType.asset, { amount: "1.25", symbol: "SYS", precision: "4" }, "1.2500 SYS"],
    [LogicalType.extended_asset, { amount: "7", symbol: "USD", precision: "2", contract: "sysio.token" }, "7.00 USD@sysio.token"],
    [LogicalType.json, { numbers: ["9007199254740993"], ok: true }, "{\"numbers\":[\"9007199254740993\"],\"ok\":true}"],
    [LogicalType.ieee_hex, "0x0000c03f", "1.5"]
  ])("display-formats %s", (logicalType, value, expected) => {
    expect(CellFormatter.format(column("c", logicalType), cell(value))).toBe(expected)
  })

  it("renders NULL with the configured text", () => {
    expect(CellFormatter.format(column("c", LogicalType.text), null)).toBe(CellFormatter.DefaultNullText)
    expect(CellFormatter.format(column("c", LogicalType.text), null, { nullText: "" })).toBe("")
    expect(createCellFormatDefaultOptions()).toEqual({ mode: CellFormatMode.display, nullText: "NULL" })
  })

  it("escapes control characters in display mode only", () => {
    const text = column("c", LogicalType.text)
    expect(CellFormatter.format(text, "a\nb\tc\u007f")).toBe("a␊b␉c␡")
    expect(CellFormatter.format(text, "a\nb", canonical)).toBe("a\nb")
  })

  it("keeps ieee_hex raw in canonical mode and for widths it cannot decode", () => {
    const hex = column("c", LogicalType.ieee_hex)
    expect(CellFormatter.format(hex, "0x00000000000004c0")).toBe("-2.5")
    expect(CellFormatter.format(hex, "0x0000c03f", canonical)).toBe("0x0000c03f")
    expect(CellFormatter.format(hex, "0x0102")).toBe("0x0102")
  })

  it("pads asset fractions to the precision with string math (0 and 18), never truncating", () => {
    expect(CellFormatter.padAssetFraction("13", 0)).toBe("13")
    expect(CellFormatter.padAssetFraction("-0.5", 18)).toBe("-0.500000000000000000")
    expect(CellFormatter.padAssetFraction("1.123456", 2)).toBe("1.123456")
  })

  it("canonical() is the lossless text; containsText() matches display text case-insensitively", () => {
    const text = column("c", LogicalType.text),
      hex = column("h", LogicalType.ieee_hex)
    expect(CellFormatter.canonical(text, "a\nb")).toBe("a\nb")
    expect(CellFormatter.canonical(hex, "0x0000c03f")).toBe("0x0000c03f")
    expect(CellFormatter.containsText(text, "Alice", "LIC")).toBe(true)
    expect(CellFormatter.containsText(hex, "0x0000c03f", "1.5")).toBe(true)
    expect(CellFormatter.containsText(text, null, "null")).toBe(true)
    expect(CellFormatter.containsText(text, "bob", "x")).toBe(false)
  })

  it.each([
    [LogicalType.integer, 42],
    [LogicalType.integer, "1.5"],
    [LogicalType.decimal, "1e2"],
    [LogicalType.boolean, "true"],
    [LogicalType.text, 5],
    [LogicalType.asset, { amount: "1", symbol: "SYS", precision: "-1" }],
    [LogicalType.asset, { amount: "x", symbol: "SYS", precision: "4" }],
    [LogicalType.extended_asset, { amount: "1", symbol: "SYS", precision: "4" }],
    [LogicalType.ieee_hex, "1.5"]
  ])("throws on a %s encoding mismatch", (logicalType, value) => {
    expect(() => CellFormatter.format(column("c", logicalType), cell(value))).toThrow("does not match")
  })
})

describe("CellFormatter.alignment", () => {
  it("right-aligns numbers and assets, left-aligns the rest", () => {
    expect(CellFormatter.alignment(column("c", LogicalType.integer))).toBe(CellAlignment.right)
    expect(CellFormatter.alignment(column("c", LogicalType.asset))).toBe(CellAlignment.right)
    expect(CellFormatter.alignment(column("c", LogicalType.text))).toBe(CellAlignment.left)
    expect(CellFormatter.alignment(column("c", LogicalType.json))).toBe(CellAlignment.left)
  })
})

describe("CellFormatter.compare", () => {
  it("compares u128 integers exactly", () => {
    const integer = column("c", LogicalType.integer)
    expect(CellFormatter.compare(integer, "340282366920938463463374607431768211455", "340282366920938463463374607431768211454")).toBe(1)
    expect(CellFormatter.compare(integer, "-5", "3")).toBe(-1)
  })

  it("rejects a fractional value in an integer column with the mismatch error", () => {
    const integer = column("c", LogicalType.integer)
    expect(() => CellFormatter.compare(integer, "1.5", "2")).toThrow("does not match its integer encoding")
  })

  it("orders ieee_hex by decoded value, falling back to text when undecodable or NaN", () => {
    const hex = column("c", LogicalType.ieee_hex),
      two = "0x00000040",
      ten = "0x00002041",
      minusOne = "0x000080bf",
      nan = "0x0000c07f"
    expect(CellFormatter.compare(hex, two, ten)).toBe(-1)
    expect(CellFormatter.compare(hex, minusOne, two)).toBe(-1)
    expect(CellFormatter.compare(hex, "0x0000000000000040", two)).toBe(0)
    expect(CellFormatter.compare(hex, "0x0102", two)).toBe(1)
    expect(CellFormatter.compare(hex, two, "0x0102")).toBe(-1)
    expect(CellFormatter.compare(hex, nan, two)).toBe(1)
  })

  it("compares decimals exactly across scales", () => {
    expect(CellFormatter.compareDecimal("1.10", "1.1")).toBe(0)
    expect(CellFormatter.compareDecimal("-0.5", "-0.25")).toBe(-1)
    expect(CellFormatter.compareDecimal("2", "10")).toBe(-1)
  })

  it("orders assets by symbol then amount", () => {
    const asset = column("c", LogicalType.asset)
    expect(CellFormatter.compare(asset, cell({ amount: "2", symbol: "SYS", precision: "4" }), cell({ amount: "10", symbol: "SYS", precision: "4" }))).toBe(-1)
    expect(CellFormatter.compare(asset, cell({ amount: "2", symbol: "ZZZ", precision: "4" }), cell({ amount: "10", symbol: "AAA", precision: "4" }))).toBe(1)
  })

  it("sorts NULL last and compares booleans and text", () => {
    const text = column("c", LogicalType.text)
    expect(CellFormatter.compare(text, null, "a")).toBe(1)
    expect(CellFormatter.compare(text, "a", null)).toBe(-1)
    expect(CellFormatter.compare(text, null, null)).toBe(0)
    expect(CellFormatter.compare(text, "a", "b")).toBe(-1)
    expect(CellFormatter.compare(column("c", LogicalType.boolean), false, true)).toBe(-1)
  })
})

describe("CellFormatter.sortKey / compareSortKeys", () => {
  it("decodes each type once into a comparable key", () => {
    expect(CellFormatter.sortKey(column("c", LogicalType.integer), "-7")).toBe(-7n)
    expect(CellFormatter.sortKey(column("c", LogicalType.decimal), "1.50")).toBe("1.50")
    expect(CellFormatter.sortKey(column("c", LogicalType.boolean), true)).toBe(true)
    expect(CellFormatter.sortKey(column("c", LogicalType.ieee_hex), "0x0000c03f")).toEqual({ hex: "0x0000c03f", decoded: 1.5 })
    expect(CellFormatter.sortKey(column("c", LogicalType.text), "a\nb")).toBe("a\nb")
    expect(CellFormatter.sortKey(column("c", LogicalType.text), null)).toBeNull()
  })

  it("compares keys of one column, NULL last; rejects a mismatched cell while keying", () => {
    const integer = column("c", LogicalType.integer)
    expect(CellFormatter.compareSortKeys(integer, 1n, 2n)).toBe(-1)
    expect(CellFormatter.compareSortKeys(integer, null, 2n)).toBe(1)
    expect(CellFormatter.compareSortKeys(column("c", LogicalType.boolean), true, false)).toBe(1)
    expect(() => CellFormatter.sortKey(integer, "x")).toThrow("does not match")
  })
})

describe("CellFormatter helpers", () => {
  it("decodes float32 / float64 hex and ignores other widths", () => {
    expect(CellFormatter.decodeIeeeHex("0x0000c03f")).toBe(1.5)
    expect(CellFormatter.decodeIeeeHex("0x00000000000004c0")).toBe(-2.5)
    expect(CellFormatter.decodeIeeeHex("0x01")).toBeNull()
  })

  it("asserts asset cells", () => {
    expect(CellFormatter.assertAsset(column("c", LogicalType.asset), cell({ amount: "1", symbol: "S", precision: "0" }))).toEqual({ amount: "1", symbol: "S", precision: "0" })
    expect(() => CellFormatter.assertAsset(column("c", LogicalType.asset), cell(["1"]))).toThrow()
    expect(() => CellFormatter.assertAsset(column("c", LogicalType.asset), cell({ amount: "1", symbol: "S", precision: "0", contract: 5 }))).toThrow(
      "does not match"
    )
    expect(AssetCellSchema.safeParse({ amount: "1.5", symbol: "S", precision: "4", contract: "c" }).success).toBe(true)
    expect(AssetCellSchema.safeParse({ amount: "1", symbol: "S" }).success).toBe(false)
  })
})
