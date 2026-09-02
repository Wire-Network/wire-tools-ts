import { ethers } from "ethers"
import { getLogger } from "@wireio/shared"
import { Constants } from "@wireio/cluster-tool"
import {
  ClusterBuildContext,
  EthereumOutpostBootstrapper,
  EthereumOutpostSteps,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

/** A context over the persisted fixture, optionally reshaped for a case. */
const context = (overrides: Parameters<typeof fixtureConfig>[0] = {}) =>
  new ClusterBuildContext(fixtureConfig(overrides), getLogger("eth-outpost-test"))

/**
 * The address the harness will later generate the operator's EM key for —
 * derived here INDEPENDENTLY (straight from ethers) so the test pins the
 * mapping rather than re-running the code under test.
 */
const expectedOperatorAddress = (index: number): string =>
  ethers.HDNodeWallet.fromPhrase(
    EthereumOutpostBootstrapper.AnvilMnemonic,
    undefined,
    `${EthereumOutpostBootstrapper.DerivationPath}${Constants.batchOperatorEthereumHdIndex(index)}`
  ).address

describe("Steps.ethereumOutpost.deploy", () => {
  it("builds an input-less deploy step with a runner", () => {
    const step = Steps.ethereumOutpost.planDeploy(
      Report.Actor.EthereumOutpost,
      "deploy-ethereum-outpost",
      "deploy the Ethereum outpost",
      {}
    )
    expect(step.actor).toBe(Report.Actor.EthereumOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })
})

describe("EthereumOutpostSteps.resolveInitialRoster", () => {
  it("carries the depot's epoch duration", async () => {
    const roster = await EthereumOutpostSteps.resolveInitialRoster(
      context({ epochDurationSec: 45 })
    )
    expect(roster.epochDurationSec).toBe(45)
  })

  it("seats EVERY batch operator, at the address its own EM key will derive to", async () => {
    // The whole point of WNE-41 on a cluster: these are the addresses the
    // daemons sign `epochIn` with, and `isActiveOperator` is fail-closed.
    const roster = await EthereumOutpostSteps.resolveInitialRoster(
      context({ batchOperatorCount: 3, operatorsPerEpoch: 3, batchOpGroups: 1 })
    )
    // Order is the depot's business — `schbatchgps` interleaves before
    // partitioning — so this asserts MEMBERSHIP, which is what authorization
    // depends on.
    expect(roster.groups.flat().sort()).toEqual(
      [
        expectedOperatorAddress(0),
        expectedOperatorAddress(1),
        expectedOperatorAddress(2)
      ].sort()
    )
  })

  it("excludes the deploy owner — deployment privilege is not delivery privilege", async () => {
    const roster = await EthereumOutpostSteps.resolveInitialRoster(context()),
      deployer = EthereumOutpostBootstrapper.generateAccounts(1)[0].address
    expect(roster.groups.flat()).not.toContain(deployer)
  })

  it("sizes group 0 by the depot's operators-per-epoch (the consensus threshold)", async () => {
    // `OPPInbound` derives its threshold from `batchOpGroups[0].length`, so a
    // group 0 wider than the depot's active group would demand deliveries that
    // never come and stall the epoch.
    const roster = await EthereumOutpostSteps.resolveInitialRoster(
      context({ batchOperatorCount: 9, operatorsPerEpoch: 3, batchOpGroups: 3 })
    )
    expect(roster.groups).toHaveLength(3)
    roster.groups.forEach(group => expect(group).toHaveLength(3))
  })

  it("still grants delivery rights to operators past the first group", async () => {
    const roster = await EthereumOutpostSteps.resolveInitialRoster(
      context({ batchOperatorCount: 9, operatorsPerEpoch: 3, batchOpGroups: 3 })
    )
    expect(roster.groups.flat()).toContain(expectedOperatorAddress(8))
    expect(new Set(roster.groups.flat()).size).toBe(9)
  })

  it("interleaves the pool the way `schbatchgps` does", async () => {
    // The depot shuffles evens-then-odds before partitioning, so group 0 is
    // [0, 2, 4] rather than [0, 1, 2]. Reproducing it keeps the initial
    // grouping the same SHAPE the depot installs on its first attestation.
    const roster = await EthereumOutpostSteps.resolveInitialRoster(
      context({ batchOperatorCount: 9, operatorsPerEpoch: 3, batchOpGroups: 3 })
    )
    expect(roster.groups[0]).toEqual([
      expectedOperatorAddress(0),
      expectedOperatorAddress(2),
      expectedOperatorAddress(4)
    ])
  })
})

describe("EthereumOutpostSteps.partitionLikeDepot", () => {
  const pool = (count: number) =>
    Array.from({ length: count }, (_unused, index) => `0x${index}`)

  it("trims to batch_operator_minimum_active before grouping", () => {
    // 9 addresses but the depot only schedules 3: group 0's length is the
    // consensus threshold, so the untrimmed pool must not widen it.
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(9), 3, 1, 3)
    expect(groups[0]).toHaveLength(3)
  })

  it("keeps a trimmed operator authorized, without raising the threshold", () => {
    // `isActiveOperator` scans every group, so an unscheduled operator still
    // needs a seat — it just must not land in group 0.
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(5), 3, 1, 3)
    expect(groups[0]).toHaveLength(3)
    expect(groups.flat()).toHaveLength(5)
    expect(groups.flat()).toContain("0x4")
  })

  it("emits exactly batch_op_groups groups when the pool fills them", () => {
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(9), 3, 3, 9)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toEqual(["0x0", "0x2", "0x4"])
  })

  it("never emits an EMPTY group — the contract rejects one", () => {
    // A pool short of `batchOpGroups * operatorsPerEpoch` yields fewer groups
    // rather than padded ones; `_installInitialRoster` reverts on an empty one.
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(3), 3, 3, 3)
    expect(groups.every(group => group.length > 0)).toBe(true)
    expect(groups.flat()).toHaveLength(3)
  })
})
