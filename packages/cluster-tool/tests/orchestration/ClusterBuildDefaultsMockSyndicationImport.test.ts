import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames } from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — mock syndication import", () => {
  let environment: ResolveEnvironment
  beforeEach(() => {
    environment = fixtureResolveEnvironment("mock-syndication-import-")
  })
  afterEach(() => {
    environment.cleanup()
  })

  it.each([false, true])(
    "defaults import off when pools=%s",
    async enableMockLiqPools => {
      const cluster = await ClusterBuildDefaults.create({
        clusterPath: Path.join(environment.rootPath, "cluster"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/ethereum",
        solanaPath: "/fake/solana",
        enableMockLiqPools
      })
      expect(cluster.config.enableMockSyndicationImport).toBe(false)
      expect(collectPhaseNames(cluster.children)).not.toContain(
        "MockSyndicationImport"
      )
    }
  )

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    "gates and orders import=%s pools=%s",
    async (enableMockSyndicationImport, enableMockLiqPools) => {
      const cluster = await ClusterBuildDefaults.create({
          clusterPath: Path.join(environment.rootPath, "cluster"),
          buildPath: environment.buildPath,
          ethereumPath: "/fake/ethereum",
          solanaPath: "/fake/solana",
          enableMockSyndicationImport,
          enableMockLiqPools
        }),
        names = collectPhaseNames(cluster.children)
      expect(names.includes("MockSyndicationImport")).toBe(
        enableMockSyndicationImport
      )
      if (enableMockSyndicationImport) {
        expect(names.indexOf("MockSyndicationImport")).toBeGreaterThan(
          names.indexOf("SyndicationConfig")
        )
        expect(names.indexOf("MockSyndicationImport")).toBeLessThan(
          names.indexOf("EpochBootstrap")
        )
      }
      ;["MockShadowBackingSolana", "MockShadowBackingEthereum"].forEach(
        name => {
          expect(names.includes(name)).toBe(
            enableMockSyndicationImport || enableMockLiqPools
          )
          if (names.includes(name)) {
            expect(names.indexOf(name)).toBeGreaterThan(
              names.indexOf("MockSyndicationImport")
            )
            expect(names.indexOf(name)).toBeGreaterThan(
              names.indexOf("MockLiqPools")
            )
            expect(names.indexOf(name)).toBeLessThan(
              names.indexOf("EpochBootstrap")
            )
          }
        }
      )
    }
  )
})
