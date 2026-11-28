import {
  OutpostChainCodename,
  OutpostChainCodenames,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { ClusterBuildDefaults, Steps } from "@wireio/cluster-tool/orchestration"
import { PersistedFixture } from "../config/clusterConfigFixture.js"

/**
 * The resolved config for a topology, off the fixture. Pure — no `resolve`, so
 * no port claiming and no host-global bind lock (see `epochConfig`'s JSDoc).
 */
function config(overrides: Partial<ClusterConfig>): ClusterConfig {
  return { ...PersistedFixture, ...overrides }
}

describe("ClusterBuildDefaults.epochConfig — batch-op group shape", () => {
  // The spec: groups = 3; assert(group_size % 2 == 1); total = groups × size.
  // Every admissible roster is 3 × odd, so the derived size is a whole ODD
  // number and `minimum_active` lands exactly ON the roster — never above it,
  // which is what `sysio.epoch::schbatchgps` asserts against.
  // The lattice/ceiling/override matrix lives in BatchOperatorSchedule.test.ts
  // (pure, no cluster). What matters HERE is that epochConfig emits the shape
  // that resolver produced, into the real `epoch::setconfig` payload.
  it.each([
    [3, 1],
    [9, 3],
    [21, 7]
  ])("emits the resolved shape for a roster of %i → %i per group", (batchOperatorCount, expectedOperatorsPerEpoch) => {
    const data = ClusterBuildDefaults.epochConfig(
      config({ batchOperatorCount }),
      OutpostChainCodename.ETHEREUM
    )
    expect(data.operators_per_epoch).toBe(expectedOperatorsPerEpoch)
    expect(data.batch_op_groups).toBe(3)
    expect(data.batch_operator_minimum_active).toBe(batchOperatorCount)
  })

  it("names the chain and carries that chain's own epoch duration", () => {
    const perChain = config({
      batchOperatorCount: 21,
      epochDurationSec: 90,
      outpostEpochDurationSec: { [OutpostChainCodename.ETHEREUM]: 60, [OutpostChainCodename.SOLANA]: 150 }
    })
    expect(ClusterBuildDefaults.epochConfig(perChain, OutpostChainCodename.ETHEREUM)).toMatchObject({
      chain_code: OutpostChainCodename.ETHEREUM,
      epoch_duration_sec: 60
    })
    expect(ClusterBuildDefaults.epochConfig(perChain, OutpostChainCodename.SOLANA)).toMatchObject({
      chain_code: OutpostChainCodename.SOLANA,
      epoch_duration_sec: 150
    })
  })

  it("leaves every chain's traffic wait and late-delivery window to the contract default, half the minimum", () => {
    OutpostChainCodenames.forEach(chain => {
      const data = ClusterBuildDefaults.epochConfig(config({ batchOperatorCount: 9 }), chain)
      expect(data.traffic_wait_sec).toBe(Steps.contracts.sysio.epoch.DefaultShareOfMinimumSec)
      expect(data.late_window_sec).toBe(Steps.contracts.sysio.epoch.DefaultShareOfMinimumSec)
    })
    expect(Steps.contracts.sysio.epoch.DefaultShareOfMinimumSec).toBe(0)
  })

  it("sizes every chain's schedule the same from the batch-operator topology", () => {
    const shapes = OutpostChainCodenames.map(chain => {
      const { chain_code: _chain, epoch_duration_sec: _duration, ...shape } =
        ClusterBuildDefaults.epochConfig(config({ batchOperatorCount: 9 }), chain)
      return shape
    })
    expect(shapes[1]).toEqual(shapes[0])
  })

  it("honors explicit group SIZE + COUNT overrides", () => {
    const data = ClusterBuildDefaults.epochConfig(
      config({
        batchOperatorCount: 21,
        operatorsPerEpoch: 3,
        batchOpGroups: 3
      }),
      OutpostChainCodename.ETHEREUM
    )
    expect(data.operators_per_epoch).toBe(3)
    expect(data.batch_op_groups).toBe(3)
    expect(data.batch_operator_minimum_active).toBe(9)
  })

  it("keeps the group size ODD when a group-COUNT override is off the lattice", () => {
    // 21 / 5 = 4.2 → floor 4 → rounded DOWN to 3: still odd, and 3 × 5 = 15 ≤ 21.
    const data = ClusterBuildDefaults.epochConfig(
      config({ batchOperatorCount: 21, batchOpGroups: 5 }),
      OutpostChainCodename.ETHEREUM
    )
    expect(data.operators_per_epoch).toBe(3)
    expect(data.batch_operator_minimum_active).toBe(15)
  })

  it("rejects an EVEN group-size override — the spec's assert(group_size % 2 == 1)", () => {
    expect(() =>
      ClusterBuildDefaults.epochConfig(
        config({ batchOperatorCount: 21, operatorsPerEpoch: 4 }),
        OutpostChainCodename.ETHEREUM
      )
    ).toThrow(/group SIZE must be ODD/)
  })

  it("rejects an override pair the roster cannot fill, naming both flags", () => {
    // 7 × 5 = 35 ACTIVE operators demanded by a 21-operator roster: this used to
    // compose fine and revert ~15 minutes later inside `schbatchgps`.
    expect(() =>
      ClusterBuildDefaults.epochConfig(
        config({
          batchOperatorCount: 21,
          operatorsPerEpoch: 7,
          batchOpGroups: 5
        }),
        OutpostChainCodename.ETHEREUM
      )
    ).toThrow(/needs 35 ACTIVE batch operators.*batch-operator-count is 21/s)
  })
})
