import Fs from "node:fs"
import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectStepNames } from "./clusterBuildFixture.js"

/** Bootstrap steps whose global order is load-bearing. */
const ScheduleBatchGroupsStep = "schedule-batch-groups"
const DeployEthereumStep = "deploy-ethereum"
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

  it("seeds both local outposts from schbatchgps before msgch::bootstrap", async () => {
    // Ethereum's initializer and Solana's opp_bootstrap both read the schedule
    // schbatchgps materialized. Neither may follow the first envelope.
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectStepNames(cluster.children)
    expect(names.indexOf(DeployEthereumStep)).toBeGreaterThan(
      names.indexOf(ScheduleBatchGroupsStep)
    )
    expect(names.indexOf(SeedSolanaRosterStep)).toBeGreaterThan(
      names.indexOf(DeployEthereumStep)
    )
    expect(names.indexOf(BootstrapEpochStep)).toBeGreaterThan(
      names.indexOf(SeedSolanaRosterStep)
    )
  })

  it("omits the roster seed in external-outpost mode, keeping the rest in order", async () => {
    // External outposts are seeded by their own operators, out of band.
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      externalOutpostConfig: externalConfigFile,
      // External mode has no local outpost to bond underwriter collateral on,
      // so `ClusterConfigProvider.resolve` demands an EXPLICIT zero.
      underwriterCount: 0
    })
    const names = collectStepNames(cluster.children)
    expect(names).not.toContain(SeedSolanaRosterStep)
    expect(names).not.toContain(DeployEthereumStep)
    expect(names.indexOf(BootstrapEpochStep)).toBeGreaterThan(
      names.indexOf(ScheduleBatchGroupsStep)
    )
  })
})
