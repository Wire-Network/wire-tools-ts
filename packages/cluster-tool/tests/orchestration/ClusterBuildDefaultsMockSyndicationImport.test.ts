import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import {
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import { collectPhaseNames, collectStepNames } from "./clusterBuildFixture.js"

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

  it.each([false, true])(
    "moves the import after operator provisioning only when batch operators underwrite (import=%s)",
    async enableMockSyndicationImport => {
      const create = (enableBatchOperatorUnderwriting: boolean) =>
          ClusterBuildDefaults.create({
            clusterPath: Path.join(
              environment.rootPath,
              `cluster-${String(enableBatchOperatorUnderwriting)}`
            ),
            buildPath: environment.buildPath,
            ethereumPath: "/fake/ethereum",
            solanaPath: "/fake/solana",
            enableMockSyndicationImport,
            enableBatchOperatorUnderwriting
          }),
        relayOnly = collectPhaseNames((await create(false)).children),
        underwriting = await create(true),
        names = collectPhaseNames(underwriting.children)
      expect(underwriting.config.batchOperatorUnderwriting).not.toBeNull()
      expect(relayOnly).not.toContain("BatchOperatorUnderwritingResources")
      expect(
        names.indexOf("BatchOperatorUnderwritingResources")
      ).toBeGreaterThan(names.indexOf("Provision batchop.c"))
      expect(names.indexOf("BatchOperatorUnderwritingResources")).toBeLessThan(
        names.indexOf("OperatorNodes")
      )
      if (!enableMockSyndicationImport) {
        expect(
          names.filter(name => name !== "BatchOperatorUnderwritingResources")
        ).toEqual(relayOnly)
        return
      }
      const provisioned = names.indexOf("Provision batchop.c")
      expect(provisioned).toBeGreaterThan(-1)
      expect(relayOnly.indexOf("MockSyndicationImport")).toBeLessThan(
        relayOnly.indexOf("Provision batchop.a")
      )
      ;[
        "MockSyndicationImport",
        "MockShadowBackingSolana",
        "MockShadowBackingEthereum"
      ].forEach(name => {
        expect(names.indexOf(name)).toBeGreaterThan(provisioned)
        expect(names.indexOf(name)).toBeLessThan(names.indexOf("OperatorNodes"))
        expect(names.indexOf(name)).toBeLessThan(
          names.indexOf("EpochBootstrap")
        )
      })
      expect(
        names.filter(name => name === "MockSyndicationImport")
      ).toHaveLength(1)
    }
  )

  it("imports credits only for the funded operators; every operator gets its RAM grant", async () => {
    const cluster = await ClusterBuildDefaults.create({
        clusterPath: Path.join(environment.rootPath, "cluster-funded-one"),
        buildPath: environment.buildPath,
        ethereumPath: "/fake/ethereum",
        solanaPath: "/fake/solana",
        enableMockSyndicationImport: true,
        enableBatchOperatorUnderwriting: true,
        batchOperatorUnderwriting: { fundedOperatorCount: 1 }
      }),
      steps = collectStepNames(cluster.children)
    expect(cluster.config.batchOperatorUnderwriting.fundedOperatorCount).toBe(1)
    expect(
      steps.filter(name => name.startsWith("import-underwriting-"))
    ).toEqual([
      "import-underwriting-batchop.a-liqsol",
      "import-underwriting-batchop.a-liqeth"
    ])
    expect(steps.filter(name => name.startsWith("underwriting-ram-"))).toEqual([
      "underwriting-ram-batchop.a",
      "underwriting-ram-batchop.b",
      "underwriting-ram-batchop.c"
    ])
  })
})
