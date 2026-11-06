import { assetUnits } from "@wireio/cluster-tool"

describe("assetUnits", () => {
  it("preserves precision, signed quantities and amounts past Number's exact range", () => {
    expect(assetUnits("2.000000001 LIQSOL")).toBe(2_000_000_001n)
    expect(assetUnits("0.000000000 LIQSOL")).toBe(0n)
    expect(assetUnits("10.000000000 WIRE")).toBe(10_000_000_000n)
    expect(assetUnits("-0.000000001 WIRE")).toBe(-1n)
    expect(assetUnits("9007199.254740993 WIRE")).toBe(9_007_199_254_740_993n)
  })
  it("rejects malformed assets", () => {
    expect(() => assetUnits("not an asset")).toThrow()
  })
})
