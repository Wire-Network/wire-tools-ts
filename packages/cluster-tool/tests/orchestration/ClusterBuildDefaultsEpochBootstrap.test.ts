import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectStepNames } from "./clusterBuildFixture.js"

/** The EpochBootstrap steps, in the order the depot requires them. */
const ScheduleBatchGroupsStep = "schedule-batch-groups"
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
      externalOutpostConfig: externalConfigFile
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
          ...(external && { externalOutpostConfig: externalConfigFile })
        }),
        names = collectStepNames(cluster.children)
      expect(names.filter(name => name === EmitWireOpregBootstrapStep)).toHaveLength(1)
      expect(names.indexOf(EmitWireOpregBootstrapStep)).toBe(
        names.indexOf(ScheduleBatchGroupsStep) + 1
      )
      expect(names.indexOf(VerifyWireOpregBootstrapStep)).toBe(
        names.indexOf(EmitWireOpregBootstrapStep) + 1
      )
    }
  )
})
