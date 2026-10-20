import { SolanaMintRecordSchema } from "@wireio/cluster-tool-shared"

/** A valid base58 mint address. */
const Mint = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"

describe("SolanaMintRecordSchema", () => {
  it("accepts a sol-mock-mints.json row", () => {
    const row = { code: 5_000_000, mint: Mint, decimals: 9 }
    expect(SolanaMintRecordSchema.parse(row)).toEqual(row)
  })

  it("rejects a mint that is not a base58 public key", () => {
    expect(
      SolanaMintRecordSchema.safeParse({ code: 1, mint: "0xabc", decimals: 9 })
        .success
    ).toBe(false)
  })

  it("rejects a fractional or negative code / decimals and an undeclared key", () => {
    expect(
      SolanaMintRecordSchema.safeParse({ code: 1.5, mint: Mint, decimals: 9 })
        .success
    ).toBe(false)
    expect(
      SolanaMintRecordSchema.safeParse({ code: 1, mint: Mint, decimals: -1 })
        .success
    ).toBe(false)
    expect(
      SolanaMintRecordSchema.safeParse({
        code: 1,
        mint: Mint,
        decimals: 9,
        symbol: "LIQSOL"
      }).success
    ).toBe(false)
  })
})
