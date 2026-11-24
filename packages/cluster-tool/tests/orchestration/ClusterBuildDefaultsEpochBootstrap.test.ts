import Path from "node:path"
import { OutpostChainCodenames } from "@wireio/cluster-tool-shared"
import { Constants } from "@wireio/cluster-tool"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  FixtureJudgePublicKey,
  FixturePanicPublicKey,
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectStepNames } from "./clusterBuildFixture.js"

/** The EpochBootstrap steps, in the order the depot requires them: one schedule per outpost chain. */
const ScheduleBatchGroupsSteps = OutpostChainCodenames.map(
  chain => `schedule-batch-groups-${chain.toLowerCase()}`
)
/** The last chain's schedule step — the emit follows it. */
const LastScheduleBatchGroupsStep = ScheduleBatchGroupsSteps[ScheduleBatchGroupsSteps.length - 1]
const EmitWireOpregBootstrapStep = "emit-wire-opreg-bootstrap"
const VerifyWireOpregBootstrapStep = "verify-wire-opreg-bootstrap"
const SeedEthereumRosterStep = "seed-ethereum-roster"
const SeedSolanaRosterStep = "seed-solana-roster"
const BootstrapEpochStep = "bootstrap-epoch"

describe("ClusterBuildDefaults — EpochBootstrap step order", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("epoch-bootstrap-")
    externalConfigFile = fixtureExternalOutpostConfig(environment.rootPath)
  })

  afterEach(() => {
    environment.cleanup()
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    }
  }

  it("seeds BOTH outpost rosters BETWEEN schbatchgps and msgch::bootstrap", async () => {
    // Load-bearing order: both seeds read the schedule `schbatchgps` just
    // materialized. Ethereum's `installInitialRoster` closes its bootstrap
    // window on the first counted epoch-1 delivery, and the SOL outpost's
    // `epoch_in` refuses to finalize the first envelope `msgch::bootstrap`
    // delivers until `opp_bootstrap` has seeded it.
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectStepNames(cluster.children)
    expect(names.indexOf(SeedEthereumRosterStep)).toBe(
      names.indexOf(VerifyWireOpregBootstrapStep) + 1
    )
    expect(names.indexOf(SeedSolanaRosterStep)).toBe(
      names.indexOf(SeedEthereumRosterStep) + 1
    )
    expect(names.indexOf(BootstrapEpochStep)).toBe(
      names.indexOf(SeedSolanaRosterStep) + 1
    )
  })

  it("omits both roster seeds in external-outpost mode, keeping the rest in order", async () => {
    // External outposts are seeded by their own operators, out of band.
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      externalOutpostConfig: externalConfigFile,
      judgePublicKey: FixtureJudgePublicKey,
      panicPublicKey: FixturePanicPublicKey
    })
    const names = collectStepNames(cluster.children)
    expect(names).not.toContain(SeedEthereumRosterStep)
    expect(names).not.toContain(SeedSolanaRosterStep)
    expect(names.indexOf(BootstrapEpochStep)).toBe(
      names.indexOf(VerifyWireOpregBootstrapStep) + 1
    )
  })

  it.each([false, true])(
    "emits then verifies wire-opreg-bootstrap.json right after schbatchgps (external outposts: %s)",
    async external => {
      // The file names the window schbatchgps just built, so it follows that
      // step immediately — in every cluster mode, ahead of anything that reads
      // the schedule.
      const cluster = await ClusterBuildDefaults.create({
          ...baseOptions(),
          ...(external && { externalOutpostConfig: externalConfigFile, judgePublicKey: FixtureJudgePublicKey, panicPublicKey: FixturePanicPublicKey })
        }),
        names = collectStepNames(cluster.children)
      expect(names.filter(name => name === EmitWireOpregBootstrapStep)).toHaveLength(1)
      expect(names.indexOf(EmitWireOpregBootstrapStep)).toBe(
        names.indexOf(LastScheduleBatchGroupsStep) + 1
      )
      expect(names.indexOf(VerifyWireOpregBootstrapStep)).toBe(
        names.indexOf(EmitWireOpregBootstrapStep) + 1
      )
    }
  )

  it("schedules every outpost chain, in outpost order, after every batch operator joined every chain", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectStepNames(cluster.children),
      firstSchedule = names.indexOf(ScheduleBatchGroupsSteps[0]),
      joins = Constants.batchOperatorLabels(3).flatMap(label =>
        OutpostChainCodenames.map(chain => `${label}-join-${chain.toLowerCase()}`)
      )
    ScheduleBatchGroupsSteps.forEach((step, index) =>
      expect(names.indexOf(step)).toBe(firstSchedule + index)
    )
    joins.forEach(join => {
      expect(names).toContain(join)
      expect(names.indexOf(join)).toBeLessThan(firstSchedule)
    })
  })
})
