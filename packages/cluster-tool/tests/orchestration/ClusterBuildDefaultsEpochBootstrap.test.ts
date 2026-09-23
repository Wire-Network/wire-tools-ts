import Fs from "node:fs"
import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectStepNames } from "./clusterBuildFixture.js"

/** The four EpochBootstrap steps, in the order the depot requires them. */
const ScheduleBatchGroupsStep = "schedule-batch-groups"
const SeedEthereumRosterStep = "seed-ethereum-roster"
const SeedSolanaRosterStep = "seed-solana-roster"
const BootstrapEpochStep = "bootstrap-epoch"

describe("ClusterBuildDefaults — EpochBootstrap step order", () => {
  let environment: ResolveEnvironment, externalConfigFile: string

  beforeEach(() => {
    environment = fixtureResolveEnvironment("epoch-bootstrap-")
    externalConfigFile = Path.join(environment.rootPath, "external-outpost.json")
    Fs.writeFileSync(
      externalConfigFile,
      JSON.stringify({
        ethereum: {
          addressFile: "outpost-addrs.json",
          abiFiles: ["eth-abis/OPP.json"],
          chainId: 11_155_111
        },
        solana: { idlFile: "solana-idls/liqsol_core.json" }
      })
    )
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
      names.indexOf(ScheduleBatchGroupsStep) + 1
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
      // External mode has no local outpost to bond underwriter collateral on,
      // so `ClusterConfigProvider.resolve` demands an EXPLICIT zero.
      underwriterCount: 0
    })
    const names = collectStepNames(cluster.children)
    expect(names).not.toContain(SeedEthereumRosterStep)
    expect(names).not.toContain(SeedSolanaRosterStep)
    expect(names.indexOf(BootstrapEpochStep)).toBe(
      names.indexOf(ScheduleBatchGroupsStep) + 1
    )
  })
})
