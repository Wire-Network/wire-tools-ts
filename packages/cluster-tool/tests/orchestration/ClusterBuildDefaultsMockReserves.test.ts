import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { fixtureResolveEnvironment, type ResolveEnvironment } from "../config/resolveEnvironmentFixture.js"

import { collectPhaseNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — mock-reserve gating", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("mock-reserves-")
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

  it("omits the MockReserves phase by default (no --enable-mock-reserves)", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("Registry")
    expect(names).not.toContain("MockReserves")
  })

  it("adds MockReserves immediately after Registry when enableMockReserves is set", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      enableMockReserves: true
    })
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("MockReserves")
    // gated phase is registered directly after the Registry phase, pre-EpochBootstrap
    expect(names.indexOf("MockReserves")).toBe(names.indexOf("Registry") + 1)
  })
})
