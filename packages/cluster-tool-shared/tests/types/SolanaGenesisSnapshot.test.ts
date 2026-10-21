import {
  SolanaGenesisSnapshotSchema,
  SolanaGenesisSnapshotSchemaCodec,
  type SolanaGenesisSnapshot
} from "@wireio/cluster-tool-shared"

/** One staker wallet's allocation. */
const Balance = {
  address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  outpostAccount: "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw",
  pretokenRecord: null,
  syndicatedLiqsol: "5000000000",
  purchasedLiqsol: "0",
  stakedShares: "5000000000",
  purchasedShares: "0",
  directlyPurchasedPretokens: "0",
  pretokenYield: "120000000",
  totalPretokens: "120000000"
}

/** A genesis export's accounting block. */
const Accounting = {
  wireState: "Launching",
  mode: "genesis",
  epoch: "7",
  poolAuthority: "8rUz82MkFsfqjpVjjgWEM66Brr1sm1R7VKZ991fF41e",
  poolBalance: "9000000000",
  poolPretokens: "120000000",
  allocatedPretokenYield: "120000000",
  unallocatedPoolPretokens: "0",
  directlyPurchasedPretokens: "0",
  totalUserPretokens: "120000000",
  totalPretokensSold: "120000000",
  ownerlessShares: "0",
  unreportedLiqsolYield: "1000000000",
  backingAvailable: "8000000000",
  maxInitialChainAmount: "3000000000",
  issues: [],
  units: {
    liqsolDecimals: 9,
    pretokenDecimals: 8,
    indexScale: "1000000000000"
  }
}

/** A minimal genesis document. */
const Snapshot = {
  schemaVersion: 1,
  programId: "5nBtmutzLgNKe8NxgTWE3uhPMm8u8T3ggTq2ApZRnbbq",
  allocationHash:
    "f19cd1b1385e75b7fd5c1950f9e53a2b47220de6e5366ba44defe5351550ff0f",
  balances: [Balance],
  accounting: Accounting
}

describe("SolanaGenesisSnapshotSchema", () => {
  it("accepts a genesis export without evidence, leaving the tranche price absent", () => {
    const snapshot: SolanaGenesisSnapshot =
      SolanaGenesisSnapshotSchema.parse(Snapshot)
    expect(snapshot.balances[0].syndicatedLiqsol).toBe("5000000000")
    expect(snapshot.accounting.units.pretokenDecimals).toBe(8)
    expect(snapshot.accounting.highestTranchePriceUsd).toBeUndefined()
  })

  it("carries the tranche price once the exporter adds it", () => {
    expect(
      SolanaGenesisSnapshotSchema.parse({
        ...Snapshot,
        accounting: { ...Accounting, highestTranchePriceUsd: "45000000" }
      }).accounting.highestTranchePriceUsd
    ).toBe("45000000")
  })

  it("rejects a preview export, a non-Launching state and units it does not convert", () => {
    expect(
      SolanaGenesisSnapshotSchema.safeParse({
        ...Snapshot,
        accounting: { ...Accounting, mode: "preview" }
      }).success
    ).toBe(false)
    expect(
      SolanaGenesisSnapshotSchema.safeParse({
        ...Snapshot,
        accounting: { ...Accounting, wireState: "PostLaunch" }
      }).success
    ).toBe(false)
    expect(
      SolanaGenesisSnapshotSchema.safeParse({
        ...Snapshot,
        accounting: {
          ...Accounting,
          units: { ...Accounting.units, pretokenDecimals: 9 }
        }
      }).success
    ).toBe(false)
  })

  it("round-trips an export through its codec and names the failing path on a bad one", () => {
    const snapshot = SolanaGenesisSnapshotSchemaCodec.deserialize(
      JSON.stringify(Snapshot)
    )
    expect(
      SolanaGenesisSnapshotSchemaCodec.deserialize(
        SolanaGenesisSnapshotSchemaCodec.serialize(snapshot)
      )
    ).toEqual(snapshot)
    expect(() =>
      SolanaGenesisSnapshotSchemaCodec.deserialize(
        JSON.stringify({ ...Snapshot, schemaVersion: 2 })
      )
    ).toThrow(/schemaVersion/)
  })

  it("rejects a non-base58 wallet and a malformed allocation hash", () => {
    expect(
      SolanaGenesisSnapshotSchema.safeParse({
        ...Snapshot,
        balances: [{ ...Balance, address: "0x1111" }]
      }).success
    ).toBe(false)
    expect(
      SolanaGenesisSnapshotSchema.safeParse({
        ...Snapshot,
        allocationHash: "F19C"
      }).success
    ).toBe(false)
  })
})
