import {
  EthereumGenesisSnapshotSchema,
  EthereumGenesisSnapshotSchemaCodec,
  type EthereumGenesisSnapshot
} from "@wireio/cluster-tool-shared"

/** A staker with a recovered key (the compressed secp256k1 generator point). */
const Staker = {
  address: "0x1111111111111111111111111111111111111111",
  pubkey:
    "0x0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  totalShares: "1000000000000000000",
  totalPrincipalIn: "1000000000000000000",
  totalAmountOut: "0",
  netPrincipal: "1000000000000000000",
  yieldClaimed: "0",
  pretokenYield: "250000000000000000"
}

/** A purchaser row. */
const Purchaser = {
  address: "0x2222222222222222222222222222222222222222",
  pretokens: "3000000000000000000",
  liqShares: "2000000000000000000",
  liqPrincipalIn: "2000000000000000000",
  yieldClaimed: "0",
  pretokenYield: "0",
  totalPretokens: "3000000000000000000"
}

/** The metadata row without the two fields the exporter has yet to add. */
const Metadata = {
  lastMessageId: "0xabc",
  lastTimestamp: "1760000000",
  latestIndex: "1000000000000000000000000000",
  totalMessages: 342,
  totalPrincipal: "3000000000000000000",
  yieldDust: "0",
  totalLiqEthStaked: "1000000000000000000",
  totalLiqEthPurchased: "2000000000000000000",
  generatedAt: "2026-10-21T00:00:00.000Z"
}

describe("EthereumGenesisSnapshotSchema", () => {
  it("accepts an opp-snapshot document and leaves the not-yet-exported fields absent", () => {
    const snapshot: EthereumGenesisSnapshot =
      EthereumGenesisSnapshotSchema.parse({
        stakers: [Staker],
        purchasers: [Purchaser],
        metadata: Metadata
      })
    expect(snapshot.stakers[0].netPrincipal).toBe("1000000000000000000")
    expect(snapshot.metadata.lastPoolLiqBalance).toBeUndefined()
    expect(snapshot.metadata.highestTranchePriceUsd).toBeUndefined()
  })

  it("carries the booked figure and the tranche price once the exporter adds them", () => {
    const snapshot = EthereumGenesisSnapshotSchema.parse({
      stakers: [Staker],
      purchasers: [],
      metadata: {
        ...Metadata,
        lastPoolLiqBalance: "83240000000000000000",
        highestTranchePriceUsd: "45000000"
      }
    })
    expect(snapshot.metadata.lastPoolLiqBalance).toBe("83240000000000000000")
    expect(snapshot.metadata.highestTranchePriceUsd).toBe("45000000")
  })

  it("accepts a staker whose key was not recovered", () => {
    expect(
      EthereumGenesisSnapshotSchema.safeParse({
        stakers: [{ ...Staker, pubkey: null }],
        purchasers: [],
        metadata: Metadata
      }).success
    ).toBe(true)
  })

  it("round-trips an export through its codec and names the failing path on a bad one", () => {
    const snapshot = EthereumGenesisSnapshotSchemaCodec.deserialize(
      JSON.stringify({ stakers: [Staker], purchasers: [Purchaser], metadata: Metadata })
    )
    expect(
      EthereumGenesisSnapshotSchemaCodec.deserialize(
        EthereumGenesisSnapshotSchemaCodec.serialize(snapshot)
      )
    ).toEqual(snapshot)
    expect(() =>
      EthereumGenesisSnapshotSchemaCodec.deserialize(
        JSON.stringify({ stakers: [{ ...Staker, netPrincipal: 1 }], purchasers: [], metadata: Metadata })
      )
    ).toThrow(/stakers\.0\.netPrincipal/)
  })

  it("rejects a 20-byte address as a pubkey, a signed amount and a missing metadata row", () => {
    expect(
      EthereumGenesisSnapshotSchema.safeParse({
        stakers: [{ ...Staker, pubkey: Staker.address }],
        purchasers: [],
        metadata: Metadata
      }).success
    ).toBe(false)
    expect(
      EthereumGenesisSnapshotSchema.safeParse({
        stakers: [{ ...Staker, netPrincipal: "-1" }],
        purchasers: [],
        metadata: Metadata
      }).success
    ).toBe(false)
    expect(
      EthereumGenesisSnapshotSchema.safeParse({ stakers: [], purchasers: [] })
        .success
    ).toBe(false)
  })
})
