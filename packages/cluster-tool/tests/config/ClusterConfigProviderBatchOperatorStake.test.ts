import { TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName } from "@wireio/sdk-core"
import { BatchOperatorUnderwritingConfig } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterConfigProvider } from "@wireio/cluster-tool/config"
import { fixtureConfig } from "./clusterConfigFixture.js"

/** A native amount in depot units. */
const native = (codename: string, amount: bigint): TokenAmount =>
  TokenAmount.create({ tokenCode: BigInt(SlugName.from(codename)), amount })

/** The default caps + the role on — the minimum a stake / reserve list rides with. */
const Enabled = { enableBatchOperatorUnderwriting: true }

describe("ClusterConfigProvider.resolveBatchOperatorUnderwriting — stake + reserve", () => {
  it("carries a set stake + reserve through, and leaves an unset list to the schema default", () => {
    const stake = [native(Constants.ETH_TOKEN_CODENAME, 5n), native(Constants.SOL_TOKEN_CODENAME, 6n)],
      resolved = ClusterConfigProvider.resolveBatchOperatorUnderwriting(
        { ...Enabled, batchOperatorUnderwriting: { stake } },
        3
      )
    expect(resolved.stake).toBe(stake)
    // Unset: absent in memory (so an equality against the two prior members
    // still holds), filled on every parse of the persisted shape.
    expect("reserve" in resolved).toBe(false)
    expect(resolved.fundedOperatorCount).toBe(3)
  })

  it("accepts a zero reserve (a reserve is non-negative) and refuses a zero stake", () => {
    expect(
      ClusterConfigProvider.resolveBatchOperatorUnderwriting(
        {
          ...Enabled,
          batchOperatorUnderwriting: {
            reserve: [
              native(Constants.ETH_TOKEN_CODENAME, 0n),
              native(Constants.SOL_TOKEN_CODENAME, 0n)
            ]
          }
        },
        3
      ).reserve.every(amount => amount.amount === 0n)
    ).toBe(true)
    expect(() =>
      ClusterConfigProvider.resolveBatchOperatorUnderwriting(
        {
          ...Enabled,
          batchOperatorUnderwriting: {
            stake: [
              native(Constants.ETH_TOKEN_CODENAME, 0n),
              native(Constants.SOL_TOKEN_CODENAME, 1n)
            ]
          }
        },
        3
      )
    ).toThrow(/batchOperatorUnderwriting\.stake amount for ETH must be positive/)
  })

  it("refuses a negative reserve", () => {
    expect(() =>
      ClusterConfigProvider.resolveBatchOperatorUnderwriting(
        {
          ...Enabled,
          batchOperatorUnderwriting: {
            reserve: [
              native(Constants.ETH_TOKEN_CODENAME, -1n),
              native(Constants.SOL_TOKEN_CODENAME, 1n)
            ]
          }
        },
        3
      )
    ).toThrow(/batchOperatorUnderwriting\.reserve amount for ETH must be non-negative/)
  })

  it("refuses a list that misses an outpost native token, repeats one, or names a non-native token", () => {
    const refuse = (stake: TokenAmount[]) =>
      expect(() =>
        ClusterConfigProvider.resolveBatchOperatorUnderwriting(
          { ...Enabled, batchOperatorUnderwriting: { stake } },
          3
        )
      ).toThrow(/batchOperatorUnderwriting\.stake must name each outpost native token \(ETH, SOL\) exactly once/)
    refuse([native(Constants.ETH_TOKEN_CODENAME, 1n)])
    refuse([
      native(Constants.ETH_TOKEN_CODENAME, 1n),
      native(Constants.ETH_TOKEN_CODENAME, 2n)
    ])
    refuse([
      native(Constants.ETH_TOKEN_CODENAME, 1n),
      native(Constants.SOL_TOKEN_CODENAME, 1n),
      native(Constants.LIQSOL_CODENAME, 1n)
    ])
    refuse([native(Constants.ETH_TOKEN_CODENAME, 1n), native("WIRE", 1n)])
  })

  it("persists a set stake through cluster-config.json and fills the unset reserve on reload", () => {
    const stake = [
        native(Constants.ETH_TOKEN_CODENAME, 123n),
        native(Constants.SOL_TOKEN_CODENAME, 456n)
      ],
      config = {
        ...fixtureConfig(),
        batchOperatorUnderwriting: {
          ...ClusterConfigProvider.resolveBatchOperatorUnderwriting(
            { ...Enabled, batchOperatorUnderwriting: { stake } },
            3
          )
        }
      },
      reloaded = ClusterConfigProvider.deserialize(
        ClusterConfigProvider.serialize(config)
      )
    expect(reloaded.batchOperatorUnderwriting.stake.map(amount => amount.amount)).toEqual([
      123n,
      456n
    ])
    expect(reloaded.batchOperatorUnderwriting.reserve).toEqual(
      BatchOperatorUnderwritingConfig.DefaultReserve
    )
  })
})
