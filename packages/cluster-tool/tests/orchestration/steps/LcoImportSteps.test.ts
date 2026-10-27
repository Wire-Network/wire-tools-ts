import Fs from "node:fs"
import { ClusterFiles } from "@wireio/cluster-tool-shared"
import { getLogger } from "@wireio/cluster-tool/logging"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildPhase,
  LcoImportPlanKey
} from "@wireio/cluster-tool/orchestration"
import { Constants } from "@wireio/cluster-tool/Constants"
import { Steps } from "@wireio/cluster-tool/orchestration/steps"
import { Report } from "@wireio/cluster-tool/report"
import {
  formatWireAsset,
  WireLcoImportTool,
  WireSyndicationTool
} from "@wireio/cluster-tool/tools/wire"
import { assetUnits } from "@wireio/cluster-tool/utils"
import { BootstrapPlatformConfig, ChainKind } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { ethers } from "ethers"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"
import {
  LcoImportFixture,
  solanaSnapshot,
  withAllocationHash
} from "../../tools/wire/lcoImportFixture.js"

const {
  SysioAuthexChainkind,
  SysioContractName,
  SysioDclaimChainkind,
  SysioSyndChainkind
} = SysioContracts
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

    it("plans the plan, one phase per chain, then the funding, reconcile, seals and verify", () => {
      const [planPhase, ethereum, solana, seal] = phases(true)
      expect(phases(true).map(phase => phase.name)).toEqual([
        "LcoImportPlan",
        "LcoImportEthereum",
        "LcoImportSolana",
        "LcoImportSeal"
      ])
      expect(planPhase.steps.map(step => [step.name, step.runner])).toEqual([
        ["publish-lco-import-plan", LcoImportSteps.runPublishPlan],
        ["verify-lco-funding", LcoImportSteps.runVerifyFunding],
        ["verify-lco-shadows-unminted", LcoImportSteps.runVerifyUnminted],
        ["write-lco-import-record", LcoImportSteps.runWriteRecord]
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
        LcoImportSteps.runReconcileClaims,
        LcoImportSteps.runReconcileSyndication,
        Steps.contracts.sysio.dclaim.runImportdone,
        Steps.contracts.sysio.synd.runImportdone,
        LcoImportSteps.runVerify
      ])
      expect(seal.steps[1].input).toEqual({
        kind: "LcoImportSteps.ReconcileClaimsInput",
        claimCount: plan.ethereum.claims.length + plan.solana.claims.length
      })
      expect(seal.steps[2].input).toEqual({
        kind: "LcoImportSteps.ReconcileSyndicationInput",
        positionCount:
          plan.ethereum.syndications.length + plan.solana.syndications.length
      })
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

    it("leaves the syndication seal to a later import when told to, still reconciling the positions", () => {
      const seal = phases(false).at(-1)
      expect(seal.steps.map(step => step.runner)).toEqual([
        Steps.contracts.sysio.token.runTransfer,
        LcoImportSteps.runReconcileClaims,
        LcoImportSteps.runReconcileSyndication,
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
    /** The fixture's booked custody per shadow, in subunits. */
    const BookedCustody = { LIQETH: 6_500_000_000n, LIQSOL: 6_000_000_000n }

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

    it("refuses exports whose allocations moved, even with the same counts and totals", async () => {
      // Swap the two wallets' pretokens: every row and total still adds up.
      const moved = solanaSnapshot(),
        [staker, purchaser] = moved.balances,
        claimOf = ({
          directlyPurchasedPretokens,
          pretokenYield,
          totalPretokens
        }: typeof staker) => ({
          directlyPurchasedPretokens,
          pretokenYield,
          totalPretokens
        }),
        stakerClaim = claimOf(staker)
      Object.assign(staker, claimOf(purchaser))
      Object.assign(purchaser, stakerClaim)
      withAllocationHash(moved)
      const ctx = new ClusterBuildContext(
        fixtureConfig({
          clusterPath: fixture.path,
          lcoImport: {
            ...config.lcoImport,
            solana: fixture.chain("moved-solana.json", moved)
          }
        }),
        getLogger("lco-import-steps-test")
      )
      await expect(
        LcoImportSteps.runPublishPlan(
          ctx,
          {
            kind: "LcoImportSteps.PublishPlanInput",
            summary: WireLcoImportTool.summarize(plan)
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

    describe("runVerifyFunding", () => {
      const Claims = WireLcoImportTool.planClaimTotal(plan),
        Reserved =
          BigInt(Constants.EMISSION_CONFIG_DEFAULTS.t5_distributable) +
          Constants.nodeOwnerCommitment(Constants.EMISSION_CONFIG_DEFAULTS)

      /** A context over `fundedPlan` whose accounts hold `balances` WIRE subunits. */
      function funded(
        balances: Record<string, bigint>,
        fundedPlan: WireLcoImportTool.Plan = plan
      ) {
        const ctx = importContext(false)
        ctx.outputs.set(LcoImportPlanKey, fundedPlan)
        jest
          .spyOn(ctx.wire, "getWireBalance")
          .mockImplementation(async account => balances[account] ?? 0n)
        return ctx
      }

      it("passes when the treasury funds the claims and keeps its commitments", async () => {
        await expect(
          LcoImportSteps.runVerifyFunding(funded({ sysio: Reserved + Claims }), null, signal)
        ).resolves.toBeUndefined()
      })

      it("fails when funding the claims would eat into the treasury's commitments", async () => {
        await expect(
          LcoImportSteps.runVerifyFunding(
            funded({ sysio: Reserved + Claims - 1n }),
            null,
            signal
          )
        ).rejects.toThrow(/sysio would keep \d+ WIRE subunits after the import, less than the \d+/)
      })

      it("checks another funding account for the claims and the treasury for its commitments", async () => {
        const treasuryFunded = { ...plan, dclaimFundingAccount: "lco.treasury" }
        await expect(
          LcoImportSteps.runVerifyFunding(
            funded({ sysio: Reserved, "lco.treasury": Claims }, treasuryFunded),
            null,
            signal
          )
        ).resolves.toBeUndefined()
        await expect(
          LcoImportSteps.runVerifyFunding(
            funded({ sysio: Reserved, "lco.treasury": Claims - 1n }, treasuryFunded),
            null,
            signal
          )
        ).rejects.toThrow(/lco\.treasury holds \d+ WIRE subunits, less than the \d+ the claims need/)
        await expect(
          LcoImportSteps.runVerifyFunding(
            funded({ sysio: Reserved - 1n, "lco.treasury": Claims }, treasuryFunded),
            null,
            signal
          )
        ).rejects.toThrow(/sysio would keep/)
      })
    })

    describe("runVerifyUnminted", () => {
      /** A context whose shadows' outstanding is `outstanding`. */
      function unminted(outstanding: Record<string, bigint>) {
        const ctx = importContext()
        jest
          .spyOn(WireSyndicationTool, "readOutstanding")
          .mockImplementation(async (_ctx, token) => outstanding[token])
        return ctx
      }

      it("passes when no imported shadow has supply yet", async () => {
        await expect(
          LcoImportSteps.runVerifyUnminted(
            unminted({ LIQETH: 0n, LIQSOL: 0n }),
            null,
            signal
          )
        ).resolves.toBeUndefined()
      })

      it("fails when an imported shadow was minted before the import", async () => {
        await expect(
          LcoImportSteps.runVerifyUnminted(
            unminted({ LIQETH: 0n, LIQSOL: 1n }),
            null,
            signal
          )
        ).rejects.toThrow(/LIQSOL already has 1 outstanding; the import must be its first mint/)
      })
    })

    describe("runReconcileClaims", () => {
      /** The plan's claims as the `sysio.dclaim::unmapped` rows the import writes, the chain by name. */
      function plannedRows(): SysioContracts.SysioDclaimUnmappedTokenType[] {
        return WireLcoImportTool.chainPlans(plan).flatMap(chainPlan =>
          chainPlan.claims.map((claim, index) => ({
            id: index + 1,
            chain_kind: SysioDclaimChainkind[
              chainPlan.chain
            ] as keyof typeof SysioDclaimChainkind,
            native_pubkey: claim.native_address,
            balance: formatWireAsset(BigInt(claim.wire_atomic))
          }))
        )
      }

      /** A context whose `unmapped` read answers `rows` in one page. */
      function reconcilable(rows: SysioContracts.SysioDclaimUnmappedTokenType[]) {
        const ctx = importContext(),
          getTableRows = jest
            .spyOn(ctx.wire, "getTableRows")
            .mockResolvedValue({ rows, more: false })
        return { ctx, getTableRows }
      }

      /** The reconcile's input, composed for `claimCount` claims. */
      function reconcileInput(claimCount = plannedRows().length) {
        return {
          kind: "LcoImportSteps.ReconcileClaimsInput" as const,
          claimCount
        }
      }

      it("passes when unmapped holds exactly the planned claims, in any order", async () => {
        const { ctx, getTableRows } = reconcilable(plannedRows().reverse())
        await expect(
          LcoImportSteps.runReconcileClaims(ctx, reconcileInput(), signal)
        ).resolves.toBeUndefined()
        expect(getTableRows).toHaveBeenCalledWith(
          expect.objectContaining({
            account: "sysio.dclaim",
            table: "unmapped",
            limit: WireSyndicationTool.TableRowLimit
          })
        )
      })

      it("reads a chain_kind the node answers as its number", async () => {
        const rows = plannedRows().map(row => ({
          ...row,
          chain_kind:
            SysioDclaimChainkind[row.chain_kind as keyof typeof SysioDclaimChainkind]
        }))
        await expect(
          LcoImportSteps.runReconcileClaims(
            reconcilable(rows).ctx,
            reconcileInput(),
            signal
          )
        ).resolves.toBeUndefined()
      })

      it("fails when a planned claim is missing", async () => {
        await expect(
          LcoImportSteps.runReconcileClaims(
            reconcilable(plannedRows().slice(1)).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/differs from the planned claims/)
      })

      it("fails when a claim's amount differs", async () => {
        const [first, ...rest] = plannedRows(),
          raised = {
            ...first,
            balance: formatWireAsset(assetUnits(first.balance) + 1n)
          }
        await expect(
          LcoImportSteps.runReconcileClaims(
            reconcilable([raised, ...rest]).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/differs from the planned claims/)
      })

      it("fails on a row the plan does not hold", async () => {
        const rows = plannedRows(),
          [first] = rows,
          stray = {
            ...first,
            id: rows.length + 1,
            native_pubkey: "00".repeat(first.native_pubkey.length / 2)
          }
        await expect(
          LcoImportSteps.runReconcileClaims(
            reconcilable([...rows, stray]).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/differs from the planned claims/)
      })

      it("fails when a planned address sits on a chain the plan does not import", async () => {
        const [first, ...rest] = plannedRows(),
          moved = {
            ...first,
            chain_kind: SysioDclaimChainkind[
              SysioDclaimChainkind.CHAIN_KIND_WIRE
            ] as keyof typeof SysioDclaimChainkind
          }
        await expect(
          LcoImportSteps.runReconcileClaims(
            reconcilable([moved, ...rest]).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/differs from the planned claims/)
      })

      it("reads unmapped page by page past a full page", async () => {
        const rows = plannedRows(),
          ctx = importContext(),
          resumeKey = JSON.stringify({ id: rows[2].id }),
          getTableRows = jest
            .spyOn(ctx.wire, "getTableRows")
            .mockResolvedValueOnce({
              rows: rows.slice(0, 2),
              more: true,
              nextKey: resumeKey
            })
            .mockResolvedValueOnce({ rows: rows.slice(2), more: false })
        await expect(
          LcoImportSteps.runReconcileClaims(ctx, reconcileInput(), signal)
        ).resolves.toBeUndefined()
        expect(getTableRows).toHaveBeenLastCalledWith(
          expect.objectContaining({ table: "unmapped", lowerBound: resumeKey })
        )
      })

      it("refuses a plan whose claim count changed after the seal was composed", async () => {
        const { ctx, getTableRows } = reconcilable(plannedRows())
        await expect(
          LcoImportSteps.runReconcileClaims(
            ctx,
            reconcileInput(plannedRows().length + 1),
            signal
          )
        ).rejects.toThrow(/the seal was composed for/)
        expect(getTableRows).not.toHaveBeenCalled()
      })
    })

    describe("runReconcileSyndication", () => {
      /** The plan's positions as the `sysio.synd::parked` rows an unlinked import writes. */
      function parkedRows(): SysioContracts.SysioSyndParkedRowType[] {
        return WireLcoImportTool.chainPlans(plan).flatMap(chainPlan =>
          chainPlan.syndications.map(spec => ({
            token_code: chainPlan.pool.tokenCode,
            chain_kind: SysioSyndChainkind[
              chainPlan.chain
            ] as keyof typeof SysioSyndChainkind,
            pubkey: WireLcoImportTool.nativeBytesHex(chainPlan.chain, spec.pubkey),
            balance: spec.amount.toString(),
            position: { index_checkpoint: "1.0", owed_wire: 0 }
          }))
        )
      }

      /** The plan's positions, in plan order: Ethereum's two, then Solana's one. */
      const positions = WireLcoImportTool.chainPlans(plan).flatMap(chainPlan =>
        chainPlan.syndications.map(spec => ({
          chain: chainPlan.chain,
          tokenCode: chainPlan.pool.tokenCode,
          pubkey: spec.pubkey,
          amount: spec.amount
        }))
      )

      /**
       * The `sysio.authex::links` row linking position `index`'s pubkey to `username`, its key
       * spelled as nodeop renders it: an EM key as unprefixed uncompressed hex, an ED key in base58.
       */
      function linkRow(
        index: number,
        username: string,
        key = index + 1
      ): SysioContracts.SysioAuthexLinksSType {
        const { chain, pubkey } = positions[index]
        return {
          key,
          username,
          chain_kind: SysioAuthexChainkind[chain] as keyof typeof SysioAuthexChainkind,
          pub_key:
            chain === ChainKind.EVM
              ? `PUB_EM_${ethers.SigningKey.computePublicKey(pubkey, false).slice(2)}`
              : `PUB_ED_${pubkey}`
        }
      }

      /**
       * A context whose `parked` and `links` reads answer `parked` and `links`, whose accounts
       * hold `balances` (`account/TOKEN` → subunits) and whose shadows' outstanding is
       * `outstanding`.
       */
      function reconcilable(
        parked: SysioContracts.SysioSyndParkedRowType[],
        outstanding: Record<string, bigint> = BookedCustody,
        links: SysioContracts.SysioAuthexLinksSType[] = [],
        balances: Record<string, bigint> = {}
      ) {
        const ctx = importContext(),
          tables: Record<string, object[]> = { parked, links },
          getTableRows = jest
            .spyOn(ctx.wire, "getTableRows")
            .mockImplementation(async ({ table }) => ({ rows: tables[table], more: false }))
        jest
          .spyOn(WireSyndicationTool, "readOutstanding")
          .mockImplementation(async (_ctx, token) => outstanding[token])
        jest
          .spyOn(WireSyndicationTool, "readLiqBalance")
          .mockImplementation(async (_ctx, account, token) => balances[`${account}/${token}`] ?? 0n)
        return { ctx, getTableRows }
      }

      /** The reconcile's input, composed for `positionCount` positions. */
      function reconcileInput(positionCount = parkedRows().length) {
        return {
          kind: "LcoImportSteps.ReconcileSyndicationInput" as const,
          positionCount
        }
      }

      it("passes when parked holds every planned position and each outstanding is its booked custody", async () => {
        const { ctx, getTableRows } = reconcilable(parkedRows().reverse())
        await expect(
          LcoImportSteps.runReconcileSyndication(ctx, reconcileInput(), signal)
        ).resolves.toBeUndefined()
        expect(getTableRows).toHaveBeenCalledWith(
          expect.objectContaining({
            account: "sysio.synd",
            table: "parked",
            limit: WireSyndicationTool.TableRowLimit
          })
        )
      })

      it("passes when a linked pubkey's position was minted to its account instead of parked", async () => {
        const { ctx, getTableRows } = reconcilable(
          parkedRows().slice(1),
          BookedCustody,
          [linkRow(0, "lcoholder")],
          { "lcoholder/LIQETH": positions[0].amount }
        )
        await expect(
          LcoImportSteps.runReconcileSyndication(ctx, reconcileInput(), signal)
        ).resolves.toBeUndefined()
        expect(getTableRows).toHaveBeenCalledWith(
          expect.objectContaining({ account: "sysio.authex", table: "links" })
        )
      })

      it("fails when an unlinked position is missing from parked", async () => {
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable(parkedRows().slice(1)).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/parked differs from the planned positions of unlinked pubkeys/)
      })

      it("fails when one linked position was skipped and another imported twice", async () => {
        // Were the two equal-sized, the outstanding would still match, so only the accounts tell.
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable(
              parkedRows().slice(2),
              BookedCustody,
              [linkRow(0, "lcoholdera"), linkRow(1, "lcoholderb")],
              { "lcoholderb/LIQETH": 2n * positions[1].amount }
            ).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(
          /lcoholdera holds 0 LIQETH, not the 3000000000 its linked positions import/
        )
      })

      it("sums the positions of several keys linked to one account", async () => {
        const both = positions[0].amount + positions[1].amount,
          links = [linkRow(0, "lcoholder"), linkRow(1, "lcoholder")]
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable(parkedRows().slice(2), BookedCustody, links, {
              "lcoholder/LIQETH": both
            }).ctx,
            reconcileInput(),
            signal
          )
        ).resolves.toBeUndefined()
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable(parkedRows().slice(2), BookedCustody, links, {
              "lcoholder/LIQETH": positions[0].amount
            }).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/lcoholder holds/)
      })

      it("credits a pubkey linked to several accounts to its lowest-keyed link, as importsynd does", async () => {
        const links = [linkRow(0, "lcolater", 9), linkRow(0, "lcofirst", 4)],
          minted = (account: string) => ({ [`${account}/LIQETH`]: positions[0].amount })
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable(parkedRows().slice(1), BookedCustody, links, minted("lcofirst")).ctx,
            reconcileInput(),
            signal
          )
        ).resolves.toBeUndefined()
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable(parkedRows().slice(1), BookedCustody, links, minted("lcolater")).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/lcofirst holds 0 LIQETH/)
      })

      it("fails when a batch was credited twice to an unlinked pubkey", async () => {
        const [first, ...rest] = parkedRows(),
          doubled = { ...first, balance: (BigInt(first.balance) * 2n).toString() }
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable([doubled, ...rest]).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/parked differs from the planned positions of unlinked pubkeys/)
      })

      it("fails on a parked position the plan does not hold", async () => {
        const rows = parkedRows(),
          [first] = rows,
          stray = { ...first, pubkey: "00".repeat(first.pubkey.length / 2) }
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable([...rows, stray]).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(/parked differs from the planned positions of unlinked pubkeys/)
      })

      it("fails when a shadow's outstanding differs from its booked custody, as a linked batch credited twice leaves it", async () => {
        await expect(
          LcoImportSteps.runReconcileSyndication(
            reconcilable(parkedRows(), {
              ...BookedCustody,
              LIQETH: BookedCustody.LIQETH + 3_000_000_000n
            }).ctx,
            reconcileInput(),
            signal
          )
        ).rejects.toThrow(
          /LIQETH outstanding 9500000000 differs from its booked custody 6500000000/
        )
      })

      it("refuses a plan whose position count changed after the seals were composed", async () => {
        const { ctx, getTableRows } = reconcilable(parkedRows())
        await expect(
          LcoImportSteps.runReconcileSyndication(
            ctx,
            reconcileInput(parkedRows().length + 1),
            signal
          )
        ).rejects.toThrow(/the seals were composed for/)
        expect(getTableRows).not.toHaveBeenCalled()
      })
    })

    describe("runVerify", () => {
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
        syndicationSealed = AbiTrue,
        funded = WireLcoImportTool.planClaimTotal(plan)
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
        jest.spyOn(ctx.wire, "getWireBalance").mockResolvedValue(funded)
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

      it("passes when sysio.dclaim held WIRE before the funding, and fails when it holds less than its claims", async () => {
        const claims = WireLcoImportTool.planClaimTotal(plan)
        await expect(
          LcoImportSteps.runVerify(
            verifiable(BookedCustody, AbiTrue, AbiTrue, claims + 1_000_000_000n),
            { kind: "LcoImportSteps.VerifyInput", sealsSyndication: true },
            signal
          )
        ).resolves.toBeUndefined()
        await expect(
          LcoImportSteps.runVerify(
            verifiable(BookedCustody, AbiTrue, AbiTrue, claims - 1n),
            { kind: "LcoImportSteps.VerifyInput", sealsSyndication: true },
            signal
          )
        ).rejects.toThrow(/less than the \d+ its claims need/)
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
