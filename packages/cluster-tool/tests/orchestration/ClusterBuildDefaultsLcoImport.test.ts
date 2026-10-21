import Path from "node:path"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { LiqPoolSpec } from "@wireio/opp-typescript-models"
import { omit } from "lodash"
import {
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import {
  LcoImportFixture,
  WeiPerEther,
  ethereumSnapshot,
  solanaSnapshot
} from "../tools/wire/lcoImportFixture.js"
import {
  collectPhaseNames,
  collectStepNames,
  findPhase
} from "./clusterBuildFixture.js"

describe("ClusterBuildDefaults — launch-data import", () => {
  let environment: ResolveEnvironment, fixture: LcoImportFixture

  beforeEach(() => {
    environment = fixtureResolveEnvironment("lco-import-compose-")
    fixture = new LcoImportFixture()
  })

  afterEach(() => {
    fixture.remove()
    environment.cleanup()
  })

  function baseOptions() {
    return {
      clusterPath: Path.join(environment.rootPath, "cluster"),
      buildPath: environment.buildPath,
      ethereumPath: "/fake/eth",
      solanaPath: "/fake/sol",
      ethereumBootstrapJsonFile: fixture.write("ethereum.json", ethereumSnapshot()),
      solanaBootstrapJsonFile: fixture.write("solana.json", solanaSnapshot())
    }
  }

  it("composes no import without an export", async () => {
    const options = omit(baseOptions(), "ethereumBootstrapJsonFile", "solanaBootstrapJsonFile"),
      names = collectPhaseNames((await ClusterBuildDefaults.create(options)).children)
    expect(names).not.toContain("LcoImport")
  })

  it("imports after the syndication config and before the first epoch, sealing synd itself, then backs the shadow", async () => {
    const cluster = await ClusterBuildDefaults.create(baseOptions()),
      names = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children)
    expect(names.indexOf("LcoImport")).toBe(names.indexOf("SyndicationConfig") + 1)
    expect(names.slice(names.indexOf("LcoImport") + 1, names.indexOf("LcoImport") + 5)).toEqual([
      "LcoImportPlan",
      "LcoImportEthereum",
      "LcoImportSolana",
      "LcoImportSeal"
    ])
    expect(names.indexOf("LcoImportSeal")).toBeLessThan(names.indexOf("EpochBootstrap"))
    expect(steps).toContain("seal-lco-syndication")
    expect(names.indexOf("MockShadowBackingSolana")).toBeGreaterThan(names.indexOf("LcoImportSeal"))
    expect(names).toContain("MockShadowBackingEthereum")
    expect(names).not.toContain("MockLiqPools")
  })

  it("leaves the syndication seal to the mock import that follows it", async () => {
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        enableMockSyndicationImport: true
      }),
      names = collectPhaseNames(cluster.children),
      steps = collectStepNames(cluster.children)
    expect(steps).not.toContain("seal-lco-syndication")
    expect(steps).toContain("seal-mock-syndication-import")
    expect(names.indexOf("MockSyndicationImport")).toBeGreaterThan(names.indexOf("LcoImportSeal"))
  })

  it("seeds the mock pool of a shadow only when the import seeds none for it", async () => {
    const ethereumOnly = omit(baseOptions(), "solanaBootstrapJsonFile"),
      bothImported = collectPhaseNames(
        (
          await ClusterBuildDefaults.create({
            ...baseOptions(),
            enableMockLiqPools: true
          })
        ).children
      ),
      ethereumImported = await ClusterBuildDefaults.create({
        ...ethereumOnly,
        enableMockLiqPools: true
      }),
      mockPools = findPhase(ethereumImported.children, "MockLiqPools")
    expect(bothImported).not.toContain("MockLiqPools")
    expect(mockPools.steps.map(step => step.input)).toEqual([
      {
        kind: "LiqContractSteps.RegliqpoolInput",
        data: Steps.registry.MockLiqPoolRegistrations.find(
          registration => registration.token_code === "LIQSOL"
        )
      }
    ])
  })

  it("refuses placeholders against external outposts and imports real values without backing them", async () => {
    const externalOutpostConfig = fixtureExternalOutpostConfig(environment.rootPath)
    await expect(
      ClusterBuildDefaults.create({
        ...baseOptions(),
        underwriterCount: 0,
        externalOutpostConfig
      })
    ).rejects.toThrow(/takes real values only/)

    const exported = ethereumSnapshot(),
      solanaExport = solanaSnapshot(),
      pool = LiqPoolSpec.create({
        fee: 30,
        conversionHorizonSec: 86_400,
        depthCapBps: 50,
        clipFloor: 1_000n
      })
    exported.metadata.lastPoolLiqBalance = (7n * WeiPerEther).toString()
    const cluster = await ClusterBuildDefaults.create({
        ...baseOptions(),
        ethereumBootstrapJsonFile: fixture.write("real-ethereum.json", exported),
        solanaBootstrapJsonFile: fixture.write("real-solana.json", solanaExport),
        lcoImport: {
          ethereum: {
            nativePriceUsd: "300000000000",
            highestTranchePriceUsd: "20000000",
            pool
          },
          solana: {
            nativePriceUsd: "15000000000",
            highestTranchePriceUsd: "20000000",
            pool
          },
          dclaimFundingAccount: "sysio"
        },
        underwriterCount: 0,
        externalOutpostConfig
      }),
      names = collectPhaseNames(cluster.children)
    expect(names).toContain("LcoImport")
    expect(names).not.toContain("MockShadowBackingSolana")
    expect(names).not.toContain("MockShadowBackingEthereum")
  })
})
