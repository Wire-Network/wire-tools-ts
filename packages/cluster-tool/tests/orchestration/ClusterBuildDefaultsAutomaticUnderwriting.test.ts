import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames } from "./clusterBuildFixture.js"

/** The phases the three automatic-underwriting options compose. */
const AutomaticUnderwritingPhaseNames = [
  "MockLiqPools",
  "MockSyndicationImport",
  "MockShadowBackingSolana",
  "MockShadowBackingEthereum",
  "BatchOperatorUnderwritingResources"
] as const

describe("ClusterBuildDefaults — automatic underwriting (create only)", () => {
  let environment: ResolveEnvironment

  beforeEach(() => {
    environment = fixtureResolveEnvironment("automatic-underwriting-")
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

  function externalOptions() {
    return {
      ...baseOptions(),
      externalOutpostConfig: fixtureExternalOutpostConfig(environment.rootPath)
    }
  }

  it("forces on exactly the three options", () => {
    expect(ClusterBuildDefaults.AutomaticUnderwritingOverrides).toEqual({
      enableBatchOperatorUnderwriting: true,
      enableMockSyndicationImport: true,
      enableMockLiqPools: true
    })
  })

  describe("mergeAutomaticUnderwriting", () => {
    it("returns the caller's options untouched when not requested", () => {
      const options = baseOptions()
      expect(
        ClusterBuildDefaults.mergeAutomaticUnderwriting(options, false)
      ).toBe(options)
    })

    it("forces all three on for local outposts, overriding an explicit false and keeping every other member", () => {
      const options = {
        ...baseOptions(),
        batchOperatorCount: 3,
        enableMockLiqPools: false,
        enableMockSyndicationImport: false,
        enableBatchOperatorUnderwriting: false
      }
      expect(
        ClusterBuildDefaults.mergeAutomaticUnderwriting(options, true)
      ).toEqual({
        ...options,
        ...ClusterBuildDefaults.AutomaticUnderwritingOverrides
      })
    })

    it("keeps an external-outpost build's options untouched", () => {
      const options = externalOptions()
      expect(
        ClusterBuildDefaults.mergeAutomaticUnderwriting(options, true)
      ).toBe(options)
    })
  })

  it("leaves every option off on the default (flow) path", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children)
    expect(cluster.config.enableMockLiqPools).toBe(false)
    expect(cluster.config.enableMockSyndicationImport).toBe(false)
    expect(cluster.config.batchOperatorUnderwriting).toBeNull()
    AutomaticUnderwritingPhaseNames.forEach(name =>
      expect(names).not.toContain(name)
    )
  })

  it("bootstraps backed automatic underwriting against LOCAL outposts, inside the epoch-zero window", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions(), {
        enableAutomaticUnderwriting: true
      }),
      names = collectPhaseNames(cluster.children)
    expect(cluster.config.enableMockLiqPools).toBe(true)
    expect(cluster.config.enableMockSyndicationImport).toBe(true)
    expect(cluster.config.batchOperatorUnderwriting).not.toBeNull()
    AutomaticUnderwritingPhaseNames.forEach(name => {
      expect(names).toContain(name)
      expect(names.indexOf(name)).toBeLessThan(names.indexOf("EpochBootstrap"))
    })
  })

  it("never turns anything on for EXTERNAL outposts", async () => {
    const cluster = await ClusterBuildDefaults.create(externalOptions(), {
        enableAutomaticUnderwriting: true
      }),
      names = collectPhaseNames(cluster.children)
    expect(names).toContain("MaterializeExternalOutposts")
    expect(cluster.config.enableMockLiqPools).toBe(false)
    expect(cluster.config.enableMockSyndicationImport).toBe(false)
    expect(cluster.config.batchOperatorUnderwriting).toBeNull()
    AutomaticUnderwritingPhaseNames.forEach(name =>
      expect(names).not.toContain(name)
    )
  })

  it("composes alongside the Solana outpost launch, as create requests both", async () => {
    const names = collectPhaseNames(
      (
        await ClusterBuildDefaults.create(baseOptions(), {
          launchSolanaOutpost: true,
          enableAutomaticUnderwriting: true
        })
      ).children
    )
    expect(names).toContain("SolanaOutpostLaunch")
    AutomaticUnderwritingPhaseNames.forEach(name =>
      expect(names).toContain(name)
    )
  })
})
