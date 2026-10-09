import { InspectedValueKind, LogicalType, ValueInspector } from "@wireio/ql-shared"

import { cell, column } from "../common/resultFixtures.js"

describe("ValueInspector", () => {
  it("breaks an extended asset down", () => {
    const inspected = ValueInspector.inspect(column("q", LogicalType.extended_asset), cell({ amount: "1.5", symbol: "SYS", precision: "4", contract: "sysio.token" }))
    expect(inspected).toMatchObject({ kind: InspectedValueKind.asset, display: "1.5000 SYS@sysio.token", column: "q" })
    expect(inspected.fields.map(field => field.label)).toEqual(["amount", "symbol", "precision", "contract"])
  })

  it("shows json members and pretty display", () => {
    const inspected = ValueInspector.inspect(column("j", LogicalType.json), cell({ a: ["1"], b: { c: null } }))
    expect(inspected.kind).toBe(InspectedValueKind.json)
    expect(inspected.fields).toEqual([{ label: "a", value: "[\"1\"]" }, { label: "b", value: "{\"c\":null}" }])
    expect(inspected.display).toContain("\n")
    expect(ValueInspector.inspect(column("j", LogicalType.json), cell([["x"]])).fields).toEqual([{ label: "0", value: "[\"x\"]" }])
  })

  it("shows raw and decoded hex", () => {
    expect(ValueInspector.inspect(column("f", LogicalType.ieee_hex), "0x0000c03f").fields).toEqual([
      { label: "raw", value: "0x0000c03f" },
      { label: "decoded", value: "1.5" }
    ])
  })

  it("shows ISO and epoch microseconds for times", () => {
    const inspected = ValueInspector.inspect(column("t", LogicalType.time), "2023-11-14T22:13:20.123")
    expect(inspected.fields).toEqual([
      { label: "iso", value: "2023-11-14T22:13:20.123" },
      { label: "epochMicros", value: "1700000000123000" }
    ])
    expect(ValueInspector.epochMicros("+10000-01-01T00:00:00")).toBe("253402300800000000")
    expect(ValueInspector.epochMicros("not a time")).toBeNull()
    expect(ValueInspector.inspect(column("t", LogicalType.time), "garbage").fields).toEqual([{ label: "iso", value: "garbage" }])
  })

  it("handles NULL and plain scalars", () => {
    expect(ValueInspector.inspect(column("n", LogicalType.integer), null)).toMatchObject({ kind: InspectedValueKind.null, fields: [] })
    expect(ValueInspector.inspect(column("n", LogicalType.integer), "5")).toMatchObject({ kind: InspectedValueKind.scalar, display: "5" })
  })

  it("labels fields from the FieldLabel identity enum", () => {
    Object.entries(ValueInspector.FieldLabel).forEach(([key, value]) => expect(value).toBe(key))
    expect(ValueInspector.inspect(column("h", LogicalType.ieee_hex), "0x0000c03f").fields.map(field => field.label)).toEqual([
      ValueInspector.FieldLabel.raw,
      ValueInspector.FieldLabel.decoded
    ])
  })
})
