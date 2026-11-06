import {
  UnsignedDecimalPattern,
  UnsignedDecimalStringSchema
} from "@wireio/cluster-tool-shared"

describe("decimalStrings", () => {
  it("accepts an unsigned decimal integer, including values past Number.MAX_SAFE_INTEGER", () => {
    expect(UnsignedDecimalPattern.test("0")).toBe(true)
    expect(
      UnsignedDecimalStringSchema.parse("83240000000000000000")
    ).toBe("83240000000000000000")
  })

  it("rejects a sign, a decimal point, an exponent, hex and a number", () => {
    ;["-1", "2.5", "1e9", "0x10", ""].forEach(value =>
      expect(UnsignedDecimalStringSchema.safeParse(value).success).toBe(false)
    )
    expect(UnsignedDecimalStringSchema.safeParse(10).success).toBe(false)
  })
})
