import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectPhaseNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — the LIQ kicker", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("kicker-")
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

  it("always deploys and configures the kicker after the emission config and the shadow-liq setup", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children)
    expect(names).toContain("Kicker")
    expect(names.indexOf("Kicker")).toBeGreaterThan(names.indexOf("Emissions"))
    expect(names.indexOf("Kicker")).toBeGreaterThan(names.indexOf("RemainingSystemAccounts"))
    expect(names.indexOf("Kicker")).toBeGreaterThan(names.indexOf("SyndicationConfig"))
    expect(names.indexOf("Kicker")).toBeLessThan(names.indexOf("EpochBootstrap"))
  })

  it.each([false, true])("keeps kicker and underwriting bootstrap dependencies ordered (underwriting=%s)", async enableBatchOperatorUnderwriting => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        enableMockLiqPools: true,
        enableMockSyndicationImport: true,
        enableBatchOperatorUnderwriting
      }),
      names = collectPhaseNames(cluster.children),
      ordered = [
        "MockLiqPools", "Kicker", "KickerPools",
        ...(enableBatchOperatorUnderwriting
          ? ["Provision batchop.c", "BatchOperatorUnderwritingResources"]
          : []),
        "MockSyndicationImport", "MockShadowBackingSolana",
        "MockShadowBackingEthereum", "EpochBootstrap"
      ]
    ordered.forEach((name, index) => {
      expect(names.filter(candidate => candidate === name)).toHaveLength(1)
      if (index > 0)
        expect(names.indexOf(name)).toBeGreaterThan(names.indexOf(ordered[index - 1]))
    })
  })

  it("adds no kicker pool without a yield pool to price it (no --enable-mock-liq-pools)", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children)
    expect(names).not.toContain("KickerPools")
  })

  it("adds the kicker pools after every regliqpool and the kicker config when the mock yield pools are seeded", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        enableMockLiqPools: true
      }),
      names = collectPhaseNames(cluster.children)
    expect(names.indexOf("Kicker")).toBeGreaterThan(names.indexOf("MockLiqPools"))
    expect(names.indexOf("KickerPools")).toBe(names.indexOf("Kicker") + 1)
    expect(names.indexOf("KickerPools")).toBeLessThan(names.indexOf("EpochBootstrap"))
  })
})
