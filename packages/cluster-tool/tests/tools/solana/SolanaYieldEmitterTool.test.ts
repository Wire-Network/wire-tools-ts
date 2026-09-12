import { PublicKey } from "@solana/web3.js"
import { ChainKind, StakingReward } from "@wireio/opp-typescript-models"
import {
  encodeStakingReward,
  type SolanaYieldEntry
} from "@wireio/cluster-tool/tools/solana"

/**
 * `StakingReward` is defined in
 * `wire-sysio/libraries/opp/proto/sysio/opp/attestations/attestations.proto`;
 * the encoder builds the GENERATED message value and hands it to the generated
 * serializer, so the `fromBinary` round-trip is the contract under test.
 */
describe("SolanaYieldEmitterTool.encodeStakingReward", () => {
  /** ASCII "SOLANA"-ish fixed chain code — the encoder is value-agnostic. */
  const chainCode = 0x534f4c414e41n,
    tokenCode = 0x534f4cn,
    staker = PublicKey.unique(),
    entry: SolanaYieldEntry = {
      staker,
      wireAccount: "yield.lnk",
      rewardAmount: 1_000_000n,
      shareBps: 10_000
    }

  it("round-trips every field through StakingReward.fromBinary", () => {
    const externalEpochRef = 3n,
      rewardEpochIndex = 1,
      decoded = StakingReward.fromBinary(
        encodeStakingReward(
          entry,
          chainCode,
          tokenCode,
          externalEpochRef,
          rewardEpochIndex
        )
      )
    expect(decoded.chainCode).toBe(chainCode)
    expect(decoded.stakerWireAccount.name).toBe(entry.wireAccount)
    expect(decoded.shareBps).toBe(entry.shareBps)
    expect(decoded.externalEpochRef).toBe(externalEpochRef)
    expect(decoded.rewardEpochIndex).toBe(rewardEpochIndex)
    expect(decoded.rewardAmount.tokenCode).toBe(tokenCode)
    expect(decoded.rewardAmount.amount).toBe(entry.rewardAmount)
    expect(decoded.stakerNativeAddress.kind).toBe(ChainKind.SVM)
    expect([...decoded.stakerNativeAddress.address]).toEqual([
      ...staker.toBytes()
    ])
  })

  it("encodes the unlinked staker's empty WIRE account", () => {
    const decoded = StakingReward.fromBinary(
      encodeStakingReward({ ...entry, wireAccount: "" }, chainCode, tokenCode, 1n, 1)
    )
    expect(decoded.stakerWireAccount.name).toBe("")
  })
})
