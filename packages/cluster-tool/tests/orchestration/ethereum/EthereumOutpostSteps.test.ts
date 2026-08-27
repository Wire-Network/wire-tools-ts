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

describe("EthereumOutpostSteps.resolveGenesisRoster", () => {
  it("carries the depot's epoch duration", async () => {
    const roster = await EthereumOutpostSteps.resolveGenesisRoster(
      context({ epochDurationSec: 45 })
    )
    expect(roster.epochDurationSec).toBe(45)
  })

  it("seats EVERY batch operator, at the address its own EM key will derive to", async () => {
    // The whole point of WNE-41 on a cluster: these are the addresses the
    // daemons sign `epochIn` with, and `isActiveOperator` is fail-closed.
    const roster = await EthereumOutpostSteps.resolveGenesisRoster(
      context({ batchOperatorCount: 3, operatorsPerEpoch: 3, batchOpGroups: 1 })
    )
    expect(roster.groups.flat()).toEqual([
      expectedOperatorAddress(0),
      expectedOperatorAddress(1),
      expectedOperatorAddress(2)
    ])
  })

  it("excludes the deploy owner — deployment privilege is not delivery privilege", async () => {
    const roster = await EthereumOutpostSteps.resolveGenesisRoster(context()),
      deployer = EthereumOutpostBootstrapper.generateAccounts(1)[0].address
    expect(roster.groups.flat()).not.toContain(deployer)
  })

  it("sizes group 0 by the depot's operators-per-epoch (the consensus threshold)", async () => {
    // `OPPInbound` derives its threshold from `batchOpGroups[0].length`, so a
    // group 0 wider than the depot's active group would demand deliveries that
    // never come and stall the epoch.
    const roster = await EthereumOutpostSteps.resolveGenesisRoster(
      context({ batchOperatorCount: 9, operatorsPerEpoch: 3, batchOpGroups: 3 })
    )
    expect(roster.groups).toHaveLength(3)
    roster.groups.forEach(group => expect(group).toHaveLength(3))
  })

  it("still grants delivery rights to operators past the first group", async () => {
    const roster = await EthereumOutpostSteps.resolveGenesisRoster(
      context({ batchOperatorCount: 9, operatorsPerEpoch: 3, batchOpGroups: 3 })
    )
    expect(roster.groups.flat()).toContain(expectedOperatorAddress(8))
    expect(new Set(roster.groups.flat()).size).toBe(9)
  })
})
