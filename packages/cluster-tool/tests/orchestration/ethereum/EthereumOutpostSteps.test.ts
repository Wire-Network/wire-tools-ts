import { ethers } from "ethers"
import { getLogger } from "@wireio/shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { Constants } from "@wireio/cluster-tool"
import {
  ClusterBuildContext,
  EthereumOutpostBootstrapper,
  EthereumOutpostSteps,
  Steps
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { fixtureOperatorAccount } from "../outputs/operatorAccountFixture.js"

/** A batch `OperatorAccount` under an explicit chain account name, with its OWN EM key. */
const batchOperator = (label: string, account: string, ethereumHdIndex: number) =>
  fixtureOperatorAccount(label, OperatorType.BATCH, account, ethereumHdIndex)

/** The depot's epoch duration for the seed cases. */
const SeedEpochDurationSec = 60

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

  it("seats every scheduled operator across the window's slots, once", async () => {
    // 9 operators, 3 groups of 3: the whole roster is scheduled, so every
    // address lands in exactly one slot — slot `k` serving epoch `1 + k`.
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

  it("leaves operators past the scheduled window OUT — the depot leaves them ungrouped too", () => {
    // Under WNE-27 a slot authorizes its members for the epoch it serves, so a
    // seat for an unscheduled operator would authorize it for an epoch the
    // depot never scheduled it for. It stays ACTIVE and ungrouped, as on the
    // depot, until a rotation schedules it.
    const groups = EthereumOutpostSteps.partitionLikeDepot(pool(5), 3, 1, 3)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(3)
    expect(groups.flat()).not.toContain("0x3")
    expect(groups.flat()).not.toContain("0x4")
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

describe("Steps.ethereumOutpost.oppBootstrap", () => {
  it("builds an input-less installInitialRoster step with a runner", () => {
    const step = Steps.ethereumOutpost.planOppBootstrap(
      Report.Actor.EthereumOutpost,
      "seed-ethereum-roster",
      "seed the Ethereum outpost batch-operator roster",
      {}
    )
    expect(step.actor).toBe(Report.Actor.EthereumOutpost)
    expect(step.input).toBeNull()
    expect(typeof step.runner).toBe("function")
  })

  it("maps every window slot, in slot order, to its members' EM addresses", () => {
    const operators = [
      batchOperator("batchop.a", "wireno.aaaaa", 1),
      batchOperator("batchop.b", "wireno.bbbbb", 2),
      batchOperator("batchop.c", "wireno.ccccc", 3)
    ]
    // The depot's window orders by ACCOUNT NAME, which need not follow the
    // harness's label order — exactly the gap the seed exists to close.
    const seed = EthereumOutpostSteps.resolveOppBootstrapSeed(
      operators,
      [["wireno.ccccc"], ["wireno.aaaaa"], ["wireno.bbbbb"]],
      0,
      SeedEpochDurationSec
    )

    expect(seed.window.groups).toEqual([
      [operators[2].ethereum.address],
      [operators[0].ethereum.address],
      [operators[1].ethereum.address]
    ])
    expect(new Set(seed.window.groups.flat()).size).toBe(3)
    expect(seed.window.epochDurationSec).toBe(SeedEpochDurationSec)
    expect(seed.activeGroupIndex).toBe(0)
  })

  it("keeps member order within a multi-member slot and carries the depot's active slot", () => {
    const operators = [
      batchOperator("batchop.a", "wireno.aaaaa", 1),
      batchOperator("batchop.b", "wireno.bbbbb", 2),
      batchOperator("batchop.c", "wireno.ccccc", 3)
    ]
    const seed = EthereumOutpostSteps.resolveOppBootstrapSeed(
      operators,
      [["wireno.bbbbb", "wireno.aaaaa", "wireno.ccccc"]],
      0,
      SeedEpochDurationSec
    )
    expect(seed.window.groups).toEqual([
      [operators[1].ethereum.address, operators[0].ethereum.address, operators[2].ethereum.address]
    ])
    // A rotated depot cursor rides through untouched.
    expect(
      EthereumOutpostSteps.resolveOppBootstrapSeed(
        operators,
        [["wireno.aaaaa"], ["wireno.bbbbb"]],
        1,
        SeedEpochDurationSec
      ).activeGroupIndex
    ).toBe(1)
  })

  it("throws when a scheduled account is not a provisioned batch operator", () => {
    const operators = [batchOperator("batchop.a", "wireno.aaaaa", 1)]
    expect(() =>
      EthereumOutpostSteps.resolveOppBootstrapSeed(
        operators,
        [["wireno.aaaaa"], ["wireno.zzzzz"]],
        0,
        SeedEpochDurationSec
      )
    ).toThrow(/wireno\.zzzzz not found among provisioned batch operators/)
  })

  it("throws a DISTINCT error when a scheduled operator carries no Ethereum key", () => {
    const keyless = { ...batchOperator("batchop.a", "wireno.aaaaa", 1), ethereum: undefined }
    expect(() =>
      EthereumOutpostSteps.resolveOppBootstrapSeed(
        [keyless],
        [["wireno.aaaaa"]],
        0,
        SeedEpochDurationSec
      )
    ).toThrow(/wireno\.aaaaa has no Ethereum key/)
  })
})
