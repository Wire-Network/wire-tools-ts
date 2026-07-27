import {
  SolanaGenesisHashByteLength,
  SolanaGenesisHashSchema
} from "@wireio/cluster-tool-shared"

describe("SolanaGenesisHash", () => {
  const ValidGenesisHash = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"

  it("accepts a canonical 32-byte Base58 identity", () => {
    expect(SolanaGenesisHashSchema.parse(ValidGenesisHash)).toBe(
      ValidGenesisHash
    )
    expect(SolanaGenesisHashByteLength).toBe(32)
  })

  it.each([
    "",
    "not-base58-0",
    "1111111111111111111111111111111",
    `1${ValidGenesisHash}`
  ])("rejects malformed or non-canonical identity %p", value => {
    expect(SolanaGenesisHashSchema.safeParse(value).success).toBe(false)
  })
})
