import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { PersistedFixture } from "../config/clusterConfigFixture.js"

/**
 * The resolved config for a topology, off the fixture. Pure — no `resolve`, so
 * no port claiming and no host-global bind lock (see `epochConfig`'s JSDoc).
 */
function config(overrides: Partial<ClusterConfig>): ClusterConfig {
  return { ...PersistedFixture, ...overrides }
}

describe("ClusterBuildDefaults.epochConfig — batch-op group shape", () => {
  // The derived default: groups = 3; group_size is the largest fitting odd
  // value; total = groups × size. The resulting roster is 3 × odd, so
  // `minimum_active` lands exactly ON the roster — never above it, which is
  // what `sysio.epoch::schbatchgps` asserts against. An explicit E=2 topology
  // is separately supported for terminal-tie validation.
  // The lattice/ceiling/override matrix lives in BatchOperatorSchedule.test.ts
  // (pure, no cluster). What matters HERE is that epochConfig emits the shape
  // that resolver produced, into the real `epoch::setconfig` payload.
  it.each([
    [3, 1],
    [9, 3],
    [21, 7]
  ])("emits the resolved shape for a roster of %i → %i per group", (batchOperatorCount, expectedOperatorsPerEpoch) => {
    const data = ClusterBuildDefaults.epochConfig(config({ batchOperatorCount }))
    expect(data.operators_per_epoch).toBe(expectedOperatorsPerEpoch)
    expect(data.batch_op_groups).toBe(3)
    expect(data.batch_operator_minimum_active).toBe(batchOperatorCount)
  })

  it("carries the global epoch duration through unchanged", () => {
    const data = ClusterBuildDefaults.epochConfig(
      config({ batchOperatorCount: 21, epochDurationSec: 90 })
    )
    expect(data.epoch_duration_sec).toBe(90)
  })

  it("honors explicit group SIZE + COUNT overrides", () => {
    const data = ClusterBuildDefaults.epochConfig(
      config({
        batchOperatorCount: 21,
        operatorsPerEpoch: 3,
        batchOpGroups: 3
      })
    )
    expect(data.operators_per_epoch).toBe(3)
    expect(data.batch_op_groups).toBe(3)
    expect(data.batch_operator_minimum_active).toBe(9)
  })

  it("keeps the group size ODD when a group-COUNT override is off the lattice", () => {
    // 21 / 5 = 4.2 → floor 4 → rounded DOWN to 3: still odd, and 3 × 5 = 15 ≤ 21.
    const data = ClusterBuildDefaults.epochConfig(
      config({ batchOperatorCount: 21, batchOpGroups: 5 })
    )
    expect(data.operators_per_epoch).toBe(3)
    expect(data.batch_operator_minimum_active).toBe(15)
  })

  it("emits the explicit terminal two-member group shape", () => {
    const data = ClusterBuildDefaults.epochConfig(
      config({ batchOperatorCount: 2, operatorsPerEpoch: 2, batchOpGroups: 1 })
    )
    expect(data.operators_per_epoch).toBe(2)
    expect(data.batch_op_groups).toBe(1)
    expect(data.batch_operator_minimum_active).toBe(2)
  })

  it("rejects an unsupported EVEN group-size override", () => {
    expect(() =>
      ClusterBuildDefaults.epochConfig(
        config({ batchOperatorCount: 21, operatorsPerEpoch: 4 })
      )
    ).toThrow(/group SIZE must be ODD or terminal size 2/)
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
        })
      )
    ).toThrow(/needs 35 ACTIVE batch operators.*batch-operator-count is 21/s)
  })
})
