import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — fixed Solana oracle", () => {
  let environment: ResolveEnvironment
  beforeEach(() => {
    environment = fixtureResolveEnvironment("fixed-oracle-plan-")
  })
  afterEach(() => environment.cleanup())

  function options() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol"
    }
  }

  it("does not install an oracle on ordinary clusters", async () => {
    const cluster = await ClusterBuildDefaults.create(options())
    expect(collectPhaseNames(cluster.children)).not.toContain(
      "SolanaFixedPriceOracle"
    )
  })

  it("prepares the enabled fixture before cluster startup and validator genesis", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...options(),
      enableSolanaFixedPriceOracle: true
    })
    const phases = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children)
    expect(phases.indexOf("SolanaFixedPriceOracle")).toBe(1)
    expect(phases.indexOf("SolanaFixedPriceOracle")).toBeLessThan(
      phases.indexOf("SolanaValidator")
    )
    expect(steps.slice(0, 2)).toEqual([
      "build-fixed-price-oracle",
      "prepare-fixed-price-feed"
    ])
    expect(steps.indexOf("prepare-fixed-price-feed")).toBeLessThan(
      steps.indexOf("start-validator")
    )
  })
})
