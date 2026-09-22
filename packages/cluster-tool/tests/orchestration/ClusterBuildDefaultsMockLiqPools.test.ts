import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"

import { collectPhaseNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — mock-liq-pool gating", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("mock-liq-pools-")
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

  it("always configures the swap, opens the shadow symbols and sets the kicker, in that order", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectPhaseNames(cluster.children)
    expect(names.indexOf("SwapConfig")).toBeGreaterThan(names.indexOf("Registry"))
    expect(names.indexOf("ShadowLiqTokens")).toBe(names.indexOf("SwapConfig") + 1)
    expect(names.indexOf("LiqConfig")).toBe(names.indexOf("ShadowLiqTokens") + 1)
    expect(names.indexOf("UnderwriterConfig")).toBeGreaterThan(names.indexOf("LiqConfig"))
  })

  it("omits the MockLiqPools phase by default (no --enable-mock-liq-pools)", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions())
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("ShadowLiqTokens")
    expect(names).not.toContain("MockLiqPools")
  })

  it("adds MockLiqPools immediately after LiqConfig when enableMockLiqPools is set", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      enableMockLiqPools: true
    })
    const names = collectPhaseNames(cluster.children)
    expect(names).toContain("MockLiqPools")
    // gated phase is registered directly after the kicker config, pre-EpochBootstrap
    expect(names.indexOf("MockLiqPools")).toBe(names.indexOf("LiqConfig") + 1)
    expect(names.indexOf("MockLiqPools")).toBeLessThan(names.indexOf("EpochBootstrap"))
  })

  it("keeps MockReserves directly after Registry when both mock surfaces are enabled", async () => {
    const cluster = await ClusterBuildDefaults.create({
      ...baseOptions(),
      enableMockReserves: true,
      enableMockLiqPools: true
    })
    const names = collectPhaseNames(cluster.children)
    expect(names.indexOf("MockReserves")).toBe(names.indexOf("Registry") + 1)
    expect(names.indexOf("SwapConfig")).toBe(names.indexOf("MockReserves") + 1)
  })
})
