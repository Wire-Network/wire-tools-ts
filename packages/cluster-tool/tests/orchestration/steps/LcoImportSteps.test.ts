import Fs from "node:fs"
import { ClusterFiles } from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  LcoImportPlanKey
} from "@wireio/cluster-tool/orchestration"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { Report } from "@wireio/cluster-tool/report"
import { WireLcoImportTool, WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { BootstrapPlatformConfig } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import { LcoImportFixture } from "../../tools/wire/lcoImportFixture.js"

const { SysioContractName } = SysioContracts
const LcoImportSteps = Steps.lcoImport
const signal = new AbortController().signal

describe("LcoImportSteps", () => {
  const fixture = new LcoImportFixture(),
    config = fixtureConfig({
      clusterPath: fixture.path,
      lcoImport: fixture.config()
    }),
    plan = WireLcoImportTool.createPlan(config.lcoImport)

  /** A context over the fixture import, its plan published when `publish` is set. */
  function importContext(publish = true): ClusterBuildContext {
    const ctx = new ClusterBuildContext(config, getLogger("lco-import-steps-test"))
    if (publish) ctx.outputs.set(LcoImportPlanKey, plan)
    return ctx
  }

  /** A context whose `getSysioContract(name)` hands back one shared client per contract. */
  function contractContext() {
    const ctx = importContext(),
      synd = ctx.wire.getSysioContract(SysioContractName.synd),
      dclaim = ctx.wire.getSysioContract(SysioContractName.dclaim)
    jest
      .spyOn(ctx.wire, "getSysioContract")
      .mockImplementation(name =>
        name === SysioContractName.synd ? synd : dclaim
      )
    return { ctx, synd, dclaim }
  }

  afterEach(() => jest.restoreAllMocks())
  afterAll(() => fixture.remove())

  describe("planImport", () => {
    /** The planned group's phases. */
    function phases(sealSyndication: boolean): ClusterBuildPhase[] {
      return LcoImportSteps.planImport(
        ClusterBuild.forContext(importContext(false)),
        "LcoImport",
        "import",
        {},
        plan,
        sealSyndication
      ).children as ClusterBuildPhase[]
    }

    it("plans the plan, one phase per chain, then the funding, seals and verify", () => {
      const [planPhase, ethereum, solana, seal] = phases(true)
      expect(phases(true).map(phase => phase.name)).toEqual([
        "LcoImportPlan",
        "LcoImportEthereum",
        "LcoImportSolana",
        "LcoImportSeal"
      ])
      expect(planPhase.steps.map(step => step.runner)).toEqual([
        LcoImportSteps.runPublishPlan,
        LcoImportSteps.runWriteRecord
      ])
      expect(planPhase.steps[0].input).toEqual({
        kind: "LcoImportSteps.PublishPlanInput",
        summary: WireLcoImportTool.summarize(plan)
      })
      expect(ethereum.steps.map(step => [step.name, step.runner])).toEqual([
        ["import-lco-syndication-ethereum-1", LcoImportSteps.runSyndicationBatch],
        ["import-lco-claims-ethereum-1", LcoImportSteps.runClaimBatch],
        ["seed-lco-pool-ethereum", Steps.contracts.sysio.liq.runRegliqpool]
      ])
      expect(ethereum.steps[0].input).toEqual({
        kind: "LcoImportSteps.SyndicationBatchInput",
        chainCode: "ETHEREUM",
        batchIndex: 0,
        creditCount: 2
      })
      expect(solana.steps[2].input).toEqual({
        kind: "LiqContractSteps.RegliqpoolInput",
        data: WireLcoImportTool.poolRegistration(plan.solana)
      })
      expect(seal.steps.map(step => step.runner)).toEqual([
        Steps.contracts.sysio.token.runTransfer,
        Steps.contracts.sysio.dclaim.runImportdone,
        Steps.contracts.sysio.synd.runImportdone,
        LcoImportSteps.runVerify
      ])
      expect(seal.steps[0].input).toEqual({
        kind: "TokenContractSteps.TransferInput",
        data: {
          from: "sysio",
          to: "sysio.dclaim",
          quantity: "8.450000000 WIRE",
          memo: LcoImportSteps.ClaimFundingMemo
        }
      })
    })

    it("leaves the syndication seal to a later import when told to", () => {
      const seal = phases(false).at(-1)
      expect(seal.steps.map(step => step.runner)).toEqual([
        Steps.contracts.sysio.token.runTransfer,
        Steps.contracts.sysio.dclaim.runImportdone,
        LcoImportSteps.runVerify
      ])
      expect(seal.steps.at(-1).input).toEqual({
        kind: "LcoImportSteps.VerifyInput",
        sealsSyndication: false
      })
    })

    it("splits a chain's positions into batches of the batch size", () => {
      const syndications = Array.from(
          { length: WireLcoImportTool.SyndicationBatchSize + 1 },
          () => plan.solana.syndications[0]
        ),
        phase = LcoImportSteps.planChainImport(
          ClusterBuild.forContext(importContext(false)),
          {},
          { ...plan.solana, syndications }
        )
      expect(phase.steps.map(step => step.input)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ batchIndex: 1, creditCount: 1 })
        ])
      )
      expect(phase.steps.filter(step => step.runner === LcoImportSteps.runSyndicationBatch)).toHaveLength(2)
    })
  })

  describe("runners", () => {
    it("publishes the plan its summary describes, and refuses one that changed", async () => {
      const ctx = importContext(false),
        { summary } = LcoImportSteps.planPublishPlan(
          Report.Actor.Sysio,
          "publish",
          "publish",
          {},
          WireLcoImportTool.summarize(plan)
        ).input
      await LcoImportSteps.runPublishPlan(
        ctx,
        { kind: "LcoImportSteps.PublishPlanInput", summary },
        signal
      )
      expect(ctx.outputs.assert(LcoImportPlanKey)).toEqual(plan)
      await expect(
        LcoImportSteps.runPublishPlan(
          importContext(false),
          {
            kind: "LcoImportSteps.PublishPlanInput",
            summary: { ...summary, dclaimFundingAccount: "someone.else" }
          },
          signal
        )
      ).rejects.toThrow(/the exports changed/)
    })

    it("writes the record into the cluster directory", async () => {
      await LcoImportSteps.runWriteRecord(importContext(), null, signal)
      const file = LcoImportSteps.recordFile(fixture.path),
        record = BootstrapPlatformConfig.fromJsonString(Fs.readFileSync(file, "utf-8"))
      expect(file.endsWith(ClusterFiles.LcoImportRecordFilename)).toBe(true)
      expect(record.liqPools.map(pool => pool.pairSymbol)).toEqual(["LIQETHP", "LIQSOLP"])
      expect(record.syndications).toHaveLength(3)
    })

    it("pushes each position batch through importsynd, refusing a resized or unknown one", async () => {
      const { ctx, synd } = contractContext(),
        invoke = jest.spyOn(synd.actions.importsynd, "invoke").mockResolvedValue(undefined)
      await LcoImportSteps.runSyndicationBatch(
        ctx,
        {
          kind: "LcoImportSteps.SyndicationBatchInput",
          chainCode: "SOLANA",
          batchIndex: 0,
          creditCount: 1
        },
        signal
      )
      expect(invoke).toHaveBeenCalledWith(WireLcoImportTool.syndicationBatch(plan.solana, 0))
      await expect(
        LcoImportSteps.runSyndicationBatch(
          ctx,
          {
            kind: "LcoImportSteps.SyndicationBatchInput",
            chainCode: "SOLANA",
            batchIndex: 0,
            creditCount: 2
          },
          signal
        )
      ).rejects.toThrow(/changed size/)
      await expect(
        LcoImportSteps.runSyndicationBatch(
          ctx,
          {
            kind: "LcoImportSteps.SyndicationBatchInput",
            chainCode: "WIRE",
            batchIndex: 0,
            creditCount: 1
          },
          signal
        )
      ).rejects.toThrow(/has no WIRE chain/)
      expect(invoke).toHaveBeenCalledTimes(1)
    })

    it("pushes each claim batch through importseed", async () => {
      const { ctx, dclaim } = contractContext(),
        invoke = jest.spyOn(dclaim.actions.importseed, "invoke").mockResolvedValue(undefined)
      await LcoImportSteps.runClaimBatch(
        ctx,
        {
          kind: "LcoImportSteps.ClaimBatchInput",
          chainCode: "ETHEREUM",
          batchIndex: 0,
          creditCount: 2
        },
        signal
      )
      expect(invoke).toHaveBeenCalledWith(WireLcoImportTool.claimBatch(plan.ethereum, 0))
    })

    describe("runVerify", () => {
      /** The fixture's booked custody per shadow, in subunits. */
      const BookedCustody = { LIQETH: 6_500_000_000n, LIQSOL: 6_000_000_000n }
      /** An ABI `bool` as the chain's JSON spells it. */
      const AbiTrue = 1,
        AbiFalse = 0

      /**
       * Mock every read the verify makes; `outstanding` maps a token to its supply. The
       * import singletons reach the typed accessors as the chain returns them, each seal an
       * ABI `bool`.
       */
      function verifiable(
        outstanding: Record<string, bigint>,
        claimsSealed = AbiTrue,
        syndicationSealed = AbiTrue
      ) {
        const ctx = importContext(),
          singletons: Record<string, object> = {
            capcfg: { imported_complete: claimsSealed },
            syndstate: { import_complete: syndicationSealed }
          }
        jest
          .spyOn(WireSyndicationTool, "readOutstanding")
          .mockImplementation(async (_ctx, token) => outstanding[token])
        jest
          .spyOn(WireSyndicationTool, "readShadowStat")
          .mockImplementation(async (_ctx, token) => ({
            supply: "",
            chain_code: "",
            token_code: token,
            pair_symbol: `${token}P`
          }))
        jest.spyOn(WireSyndicationTool, "readMismatches").mockResolvedValue([])
        jest
          .spyOn(ctx.wire, "getWireBalance")
          .mockResolvedValue(WireLcoImportTool.planClaimTotal(plan))
        jest
          .spyOn(ctx.wire, "getTableRows")
          .mockImplementation(async ({ table }) => ({ rows: [singletons[table]], more: false }))
        return ctx
      }

      it("passes when each shadow's outstanding is its booked custody and both imports are sealed", async () => {
        await expect(
          LcoImportSteps.runVerify(
            verifiable(BookedCustody),
            { kind: "LcoImportSteps.VerifyInput", sealsSyndication: true },
            signal
          )
        ).resolves.toBeUndefined()
      })

      it("fails when the claim import is not sealed", async () => {
        await expect(
          LcoImportSteps.runVerify(
            verifiable(BookedCustody, AbiFalse),
            { kind: "LcoImportSteps.VerifyInput", sealsSyndication: true },
            signal
          )
        ).rejects.toThrow(/the sysio.dclaim import is not sealed/)
      })

      it("fails when it sealed the syndication import and that import is not sealed", async () => {
        await expect(
          LcoImportSteps.runVerify(
            verifiable(BookedCustody, AbiTrue, AbiFalse),
            { kind: "LcoImportSteps.VerifyInput", sealsSyndication: true },
            signal
          )
        ).rejects.toThrow(/the sysio.synd import is not sealed/)
      })

      it("ignores the syndication seal when the import left it open", async () => {
        await expect(
          LcoImportSteps.runVerify(
            verifiable(BookedCustody, AbiTrue, AbiFalse),
            { kind: "LcoImportSteps.VerifyInput", sealsSyndication: false },
            signal
          )
        ).resolves.toBeUndefined()
      })

      it("fails when a shadow's outstanding differs from its booked custody", async () => {
        await expect(
          LcoImportSteps.runVerify(
            verifiable({ ...BookedCustody, LIQETH: BookedCustody.LIQETH + 1n }),
            { kind: "LcoImportSteps.VerifyInput", sealsSyndication: true },
            signal
          )
        ).rejects.toThrow(/LIQETH outstanding 6500000001 must equal its booked custody 6500000000/)
      })
    })
  })
})
