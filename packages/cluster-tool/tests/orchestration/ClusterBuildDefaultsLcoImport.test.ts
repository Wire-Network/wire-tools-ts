import Path from "node:path"
import { Constants } from "@wireio/cluster-tool/Constants"
import { ClusterBuildDefaults } from "@wireio/cluster-tool/orchestration"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { WireLcoImportTool } from "@wireio/cluster-tool/tools/wire"
import { LiqPoolSpec } from "@wireio/opp-typescript-models"
import { omit } from "lodash"
import {
  ExternalOutpostProgramId,
  fixtureExternalOutpostConfig,
  fixtureResolveEnvironment,
  type ResolveEnvironment
} from "../config/resolveEnvironmentFixture.js"
import {
  LcoImportFixture,
  WeiPerEther,
  ethereumSnapshot,
  solanaSnapshot,
  withAllocationHash
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

  it("carves every seeded pool's WIRE out of the T5 distributable it configures", async () => {
    const ethereumOnly = omit(baseOptions(), "solanaBootstrapJsonFile"),
      cluster = await ClusterBuildDefaults.create({
        ...ethereumOnly,
        enableMockLiqPools: true
      }),
      plan = WireLcoImportTool.createPlan({
        ethereum: fixture.chain("earmark-ethereum.json", ethereumSnapshot()),
        solana: null,
        dclaimFundingAccount: null
      }),
      mockSolanaPool = Steps.registry.MockLiqPoolRegistrations.find(
        registration => registration.token_code === "LIQSOL"
      ),
      dexEarmark =
        WireLcoImportTool.dexEarmark(plan) +
        BigInt(mockSolanaPool.initial_wire_amount),
      setEmitConfig = findPhase(cluster.children, "Emissions").steps.find(
        step => step.name === "set-emit-config"
      )
    expect(setEmitConfig.input).toEqual({
      kind: "SystemContractSteps.SetemitcfgInput",
      data: ClusterBuildDefaults.emissionConfig(dexEarmark)
    })
    expect(ClusterBuildDefaults.emissionConfig(dexEarmark).t5_distributable).toBe(
      (
        BigInt(Constants.EMISSION_CONFIG_DEFAULTS.t5_distributable) - dexEarmark
      ).toString()
    )
    expect(ClusterBuildDefaults.emissionConfig(dexEarmark).t5_floor).toBe(
      Constants.EMISSION_CONFIG_DEFAULTS.t5_floor
    )
    expect(() =>
      ClusterBuildDefaults.emissionConfig(
        BigInt(Constants.EMISSION_CONFIG_DEFAULTS.t5_distributable) + 1n
      )
    ).toThrow(/exceed the T5 allotment/)
  })

  it("refuses, before anything runs, claims that cannot fit the supply beside the T5 allotment and node-owner commitments", async () => {
    // 1,000,000,000 WIRE − 375,000,000 (T5, pools included) − 341,500,000 (node owners).
    const room =
        Constants.WIRE_SUPPLY -
        BigInt(Constants.EMISSION_CONFIG_DEFAULTS.t5_distributable) -
        Constants.nodeOwnerCommitment(Constants.EMISSION_CONFIG_DEFAULTS),
      // The fixture's other Ethereum claim: the staker's 1.25 WIRE.
      stakerClaim = 1_250_000_000n,
      claiming = (claims: bigint) => {
        const exported = ethereumSnapshot(),
          pretokens = ((claims - stakerClaim) * 10n ** 9n).toString()
        exported.purchasers[0].pretokens = pretokens
        exported.purchasers[0].totalPretokens = pretokens
        return ClusterBuildDefaults.create({
          ...omit(baseOptions(), "solanaBootstrapJsonFile"),
          ethereumBootstrapJsonFile: fixture.write(`claims-${claims}.json`, exported)
        })
      }
    expect(room).toBe(283_500_000n * 10n ** 9n)
    await expect(claiming(room)).resolves.toBeDefined()
    await expect(claiming(room + 1n)).rejects.toThrow(
      /the bootstrap commits 1000000000000000001 WIRE subunits .*, beyond the 1000000000000000000 supply/
    )
    // The pools sit inside the T5 allotment, so the earmark moves no budget.
    expect(() =>
      ClusterBuildDefaults.assertWireBudget(room, 80_000_000_000_000n)
    ).not.toThrow()
    expect(() => ClusterBuildDefaults.assertWireBudget(room + 1n, 0n)).toThrow(
      /claims 283500000000000001, T5 distributable 375000000000000000, pools 0, node owners 341500000000000000/
    )
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

  it("refuses placeholders and another program's export against external outposts, and imports real values without backing them", async () => {
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
        depthCapBps: 30,
        clipFloor: 1_000n
      })
    exported.metadata.lastPoolLiqBalance = (7n * WeiPerEther).toString()
    const realOptions = (solanaFile: string) => ({
      ...baseOptions(),
      ethereumBootstrapJsonFile: fixture.write("real-ethereum.json", exported),
      solanaBootstrapJsonFile: solanaFile,
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
    })
    await expect(
      ClusterBuildDefaults.create(
        realOptions(fixture.write("other-program.json", solanaExport))
      )
    ).rejects.toThrow(/the Solana export was read from program/)

    solanaExport.programId = ExternalOutpostProgramId
    withAllocationHash(solanaExport)
    const cluster = await ClusterBuildDefaults.create(
        realOptions(fixture.write("real-solana.json", solanaExport))
      ),
      names = collectPhaseNames(cluster.children)
    expect(names).toContain("LcoImport")
    expect(names).not.toContain("MockShadowBackingSolana")
    expect(names).not.toContain("MockShadowBackingEthereum")
  })
})
