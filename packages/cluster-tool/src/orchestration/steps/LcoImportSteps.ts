import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ClusterFiles, type ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import { range, toLower, upperFirst } from "lodash"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { WireLcoImportTool } from "../../tools/wire/WireLcoImportTool.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { formatWireAsset } from "../../tools/wire/WireUserTool.js"
import { eachSeries } from "../../utils/asyncUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import { ClusterBuildPhaseGroup } from "../ClusterBuildPhaseGroup.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { LcoImportPlanKey } from "../outputs/LcoImportPlanOutput.js"
import type { StepInput } from "../StepRunner.js"
import { DclaimContractSteps } from "./contracts/sysio/DclaimContractSteps.js"
import { LiqContractSteps } from "./contracts/sysio/LiqContractSteps.js"
import { SyndContractSteps } from "./contracts/sysio/SyndContractSteps.js"
import { TokenContractSteps } from "./contracts/sysio/TokenContractSteps.js"

const log = getLogger(__filename)

const { SysioContractAccount, SysioContractName } = SysioContracts
const { Actor } = Report

/**
 * The launch-data (LCO) import: each outpost's frozen pre-launch export replayed onto the
 * depot during epoch zero — every syndicated position (`sysio.synd::importsynd`), every
 * WIRE claim (`sysio.dclaim::importseed`) and each chain's LCO yield pool
 * (`sysio.liq::regliqpool`), then the claims funded, both imports sealed and the result
 * verified. One write per Step; the positions and claims ride the published plan
 * ({@link LcoImportPlanKey}) so each batch's Report row stays small, and the plan's record
 * (`ClusterFiles.LcoImportRecordFilename`) lists every value imported.
 */
export namespace LcoImportSteps {
  /** Memo on the transfer funding `sysio.dclaim` with every imported claim. */
  export const ClaimFundingMemo = "launch-data import: WIRE claims"

  /** Input for {@link planPublishPlan}: the plan's summary the run must reproduce. */
  export interface PublishPlanInput extends StepInput {
    readonly kind: "LcoImportSteps.PublishPlanInput"
    readonly summary: WireLcoImportTool.Summary
  }

  /** Input for {@link planSyndicationBatch}: one batch of a chain's positions. */
  export interface SyndicationBatchInput extends StepInput {
    readonly kind: "LcoImportSteps.SyndicationBatchInput"
    /** The depot chain code of the batch's chain. */
    readonly chainCode: string
    /** The batch index, from 0. */
    readonly batchIndex: number
    /** The credits the batch carries. */
    readonly creditCount: number
  }

  /** Input for {@link planClaimBatch}: one batch of a chain's WIRE claims. */
  export interface ClaimBatchInput extends StepInput {
    readonly kind: "LcoImportSteps.ClaimBatchInput"
    /** The depot chain code of the batch's chain. */
    readonly chainCode: string
    /** The batch index, from 0. */
    readonly batchIndex: number
    /** The credits the batch carries. */
    readonly creditCount: number
  }

  /** Input for {@link planVerify}. */
  export interface VerifyInput extends StepInput {
    readonly kind: "LcoImportSteps.VerifyInput"
    /** Whether this import sealed `sysio.synd`'s import. */
    readonly sealsSyndication: boolean
  }

  /**
   * ONE PhaseGroup holding the whole import: the plan and its record, one Phase per
   * exported chain (its position batches, claim batches and pool), and the funding, seals
   * and verify. Must run during epoch zero, after the shadow symbols, the swap and
   * `sysio.dclaim` are configured and before any other mint of an imported shadow.
   * Self-registers on `parent`.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short group name.
   * @param description - Human-readable group description.
   * @param options - Step option overrides threaded to every Step.
   * @param plan - The import's plan (`WireLcoImportTool.createPlan`).
   * @param sealSyndication - Seal `sysio.synd`'s import here; false when a later phase
   *   imports positions too and seals it.
   * @returns The self-registered group.
   */
  export function planImport<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: WireLcoImportTool.Plan,
    sealSyndication: boolean
  ): ClusterBuildPhaseGroup<C> {
    const group = ClusterBuildPhaseGroup.create<C>(parent, name, description),
      claimTotal = WireLcoImportTool.planClaimTotal(plan)
    ClusterBuildPhase.create<C>(
      group,
      "LcoImportPlan",
      "Read the exports, publish the import plan and write its record",
      [
        planPublishPlan<C>(
          Actor.Sysio,
          "publish-lco-import-plan",
          "read and validate the exports and publish the import plan",
          options,
          WireLcoImportTool.summarize(plan)
        ),
        planWriteRecord<C>(
          Actor.Sysio,
          "write-lco-import-record",
          `write ${ClusterFiles.LcoImportRecordFilename} (every imported pool and position)`,
          options
        )
      ]
    )
    WireLcoImportTool.chainPlans(plan).forEach(chainPlan =>
      planChainImport<C>(group, options, chainPlan)
    )
    ClusterBuildPhase.create<C>(
      group,
      "LcoImportSeal",
      "Fund the WIRE claims, seal the imports and verify them",
      [
        ...(claimTotal > 0n
          ? [
              TokenContractSteps.planTransfer<C>(
                Actor.Sysio,
                "fund-lco-claims",
                `fund sysio.dclaim with the ${formatWireAsset(claimTotal)} of imported claims`,
                options,
                {
                  from: plan.dclaimFundingAccount,
                  to: SysioContractAccount[SysioContractName.dclaim],
                  quantity: formatWireAsset(claimTotal),
                  memo: ClaimFundingMemo
                }
              )
            ]
          : []),
        DclaimContractSteps.planImportdone<C>(
          Actor.Sysio,
          "seal-lco-claims",
          "seal the sysio.dclaim import",
          options,
          {}
        ),
        ...(sealSyndication
          ? [
              SyndContractSteps.planImportdone<C>(
                Actor.Sysio,
                "seal-lco-syndication",
                "seal the sysio.synd import",
                options,
                {}
              )
            ]
          : []),
        planVerify<C>(
          Actor.Sysio,
          "verify-lco-import",
          "each imported shadow's outstanding equals its booked custody, each pool exists, the claims are funded and the imports sealed",
          options,
          sealSyndication
        )
      ]
    )
    return group
  }

  /**
   * ONE Phase importing one chain: its position batches, its claim batches, then its pool.
   * Self-registers on `parent`.
   *
   * @param parent - The import's group.
   * @param options - Step option overrides threaded to every Step.
   * @param chainPlan - The chain's plan.
   * @returns The self-registered phase.
   */
  export function planChainImport<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    options: ClusterBuildStepOptions,
    chainPlan: WireLcoImportTool.ChainPlan
  ): ClusterBuildPhase<C> {
    const { chainCode, tokenCode } = chainPlan.pool,
      label = chainCode.toLowerCase(),
      syndicationBatches = WireLcoImportTool.batchCount(
        chainPlan.syndications.length,
        WireLcoImportTool.SyndicationBatchSize
      ),
      claimBatches = WireLcoImportTool.batchCount(
        chainPlan.claims.length,
        WireLcoImportTool.ClaimBatchSize
      )
    return ClusterBuildPhase.create<C>(
      parent,
      `LcoImport${upperFirst(toLower(chainCode))}`,
      `Import the ${chainCode} positions, claims and ${tokenCode} pool`,
      [
        ...range(syndicationBatches).map(batchIndex =>
          planSyndicationBatch<C>(
            Actor.Sysio,
            `import-lco-syndication-${label}-${batchIndex + 1}`,
            `import ${tokenCode} positions, batch ${batchIndex + 1}/${syndicationBatches}`,
            options,
            chainCode,
            batchIndex,
            WireLcoImportTool.syndicationBatch(chainPlan, batchIndex).credits
              .length
          )
        ),
        ...range(claimBatches).map(batchIndex =>
          planClaimBatch<C>(
            Actor.Sysio,
            `import-lco-claims-${label}-${batchIndex + 1}`,
            `import ${chainCode} WIRE claims, batch ${batchIndex + 1}/${claimBatches}`,
            options,
            chainCode,
            batchIndex,
            WireLcoImportTool.claimBatch(chainPlan, batchIndex).credits.length
          )
        ),
        LiqContractSteps.planRegliqpool<C>(
          Actor.Sysio,
          `seed-lco-pool-${label}`,
          `seed the ${tokenCode}/WIRE pool with the LCO ${tokenCode}`,
          options,
          WireLcoImportTool.poolRegistration(chainPlan)
        )
      ]
    )
  }

  /** Publish the import plan, checked against the summary the bootstrap was composed from. */
  export function planPublishPlan<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    summary: WireLcoImportTool.Summary
  ): ClusterBuildStep<C, PublishPlanInput> {
    return ClusterBuildStep.create<C, PublishPlanInput>(
      actor,
      name,
      description,
      options,
      { kind: "LcoImportSteps.PublishPlanInput", summary },
      runPublishPlan
    )
  }

  /**
   * Named runner — re-read the exports, refuse a plan that no longer matches the composed
   * summary, publish it under {@link LcoImportPlanKey}, and warn of every placeholder.
   */
  export async function runPublishPlan<C extends ClusterBuildContext>(
    ctx: C,
    input: PublishPlanInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const plan = WireLcoImportTool.createPlan(ctx.config.lcoImport)
    Assert.ok(
      plan != null,
      "LcoImportSteps: the cluster config carries no launch-data import"
    )
    Assert.deepStrictEqual(
      WireLcoImportTool.summarize(plan),
      input.summary,
      "LcoImportSteps: the exports changed after the bootstrap was composed"
    )
    ctx.outputs.set(LcoImportPlanKey, plan)
    plan.placeholders.forEach(placeholder =>
      log.warn(
        `[lco-import] PLACEHOLDER ${placeholder.setting} = ${placeholder.value}`
      )
    )
    StepExtraRecorder.note("launch-data import plan", {
      placeholders: plan.placeholders
    })
  }

  /**
   * The record's path in a cluster directory.
   *
   * @param clusterPath - The cluster directory.
   * @returns The record file.
   */
  export function recordFile(clusterPath: ClusterConfig["clusterPath"]): string {
    return Path.join(clusterPath, ClusterFiles.LcoImportRecordFilename)
  }

  /** Write the plan's record — a `BootstrapPlatformConfig` of every pool and position. */
  export function planWriteRecord<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runWriteRecord
    )
  }

  /** Named runner — write the record, its network label the cluster directory's name. */
  export async function runWriteRecord<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { clusterPath } = ctx.config,
      record = WireLcoImportTool.toBootstrapPlatformConfig(
        ctx.outputs.assert(LcoImportPlanKey),
        Path.basename(clusterPath)
      ),
      file = recordFile(clusterPath)
    Fs.writeFileSync(file, WireLcoImportTool.serializeRecord(record))
    StepExtraRecorder.note("wrote the launch-data import record", {
      file,
      liqPools: record.liqPools.length,
      syndications: record.syndications.length
    })
  }

  /** One `sysio.synd::importsynd` batch of a chain's positions. */
  export function planSyndicationBatch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: string,
    batchIndex: number,
    creditCount: number
  ): ClusterBuildStep<C, SyndicationBatchInput> {
    return ClusterBuildStep.create<C, SyndicationBatchInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "LcoImportSteps.SyndicationBatchInput",
        chainCode,
        batchIndex,
        creditCount
      },
      runSyndicationBatch
    )
  }

  /** Named runner — push one batch of the published plan's positions. */
  export async function runSyndicationBatch<C extends ClusterBuildContext>(
    ctx: C,
    input: SyndicationBatchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const data = WireLcoImportTool.syndicationBatch(
      assertChainPlan(ctx, input.chainCode),
      input.batchIndex
    )
    Assert.strictEqual(
      data.credits.length,
      input.creditCount,
      `LcoImportSteps: ${input.chainCode} position batch ${input.batchIndex} changed size`
    )
    await SyndContractSteps.runImportsynd(
      ctx,
      { kind: "SyndContractSteps.ImportsyndInput", data },
      signal
    )
  }

  /** One `sysio.dclaim::importseed` batch of a chain's WIRE claims. */
  export function planClaimBatch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: string,
    batchIndex: number,
    creditCount: number
  ): ClusterBuildStep<C, ClaimBatchInput> {
    return ClusterBuildStep.create<C, ClaimBatchInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "LcoImportSteps.ClaimBatchInput",
        chainCode,
        batchIndex,
        creditCount
      },
      runClaimBatch
    )
  }

  /** Named runner — push one batch of the published plan's claims. */
  export async function runClaimBatch<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimBatchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const data = WireLcoImportTool.claimBatch(
      assertChainPlan(ctx, input.chainCode),
      input.batchIndex
    )
    Assert.strictEqual(
      data.credits.length,
      input.creditCount,
      `LcoImportSteps: ${input.chainCode} claim batch ${input.batchIndex} changed size`
    )
    await DclaimContractSteps.runImportseed(
      ctx,
      { kind: "DclaimContractSteps.ImportseedInput", data },
      signal
    )
  }

  /** Verify the import on the depot — the Report checkpoint closing it. */
  export function planVerify<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    sealsSyndication: boolean
  ): ClusterBuildStep<C, VerifyInput> {
    return ClusterBuildStep.create<C, VerifyInput>(
      actor,
      name,
      description,
      options,
      { kind: "LcoImportSteps.VerifyInput", sealsSyndication },
      runVerify
    )
  }

  /**
   * Named runner — each imported shadow's outstanding equals its booked custody (the
   * import is that shadow's first mint), each shadow carries its pool, `sysio.dclaim` holds
   * exactly the claims, the claim import is sealed (and the syndication import when this
   * import sealed it), and no custody mismatch exists.
   */
  export async function runVerify<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const plan = ctx.outputs.assert(LcoImportPlanKey)
    await eachSeries(WireLcoImportTool.chainPlans(plan), async chainPlan => {
      const { pool } = chainPlan,
        outstanding = await WireSyndicationTool.readOutstanding(
          ctx,
          pool.tokenCode
        ),
        stat = await WireSyndicationTool.readShadowStat(ctx, pool.tokenCode)
      Assert.strictEqual(
        outstanding,
        pool.custodyTotal,
        `LcoImportSteps: ${pool.tokenCode} outstanding ${outstanding} must equal its booked custody ${pool.custodyTotal}: the pool's LCO liq plus every imported position`
      )
      Assert.strictEqual(
        stat.pair_symbol,
        pool.pairSymbol,
        `LcoImportSteps: ${pool.tokenCode} has no ${pool.pairSymbol} pool`
      )
    })
    const claims = WireLcoImportTool.planClaimTotal(plan),
      funded = await ctx.wire.getWireBalance(
        SysioContractAccount[SysioContractName.dclaim]
      ),
      claimConfig = await ctx.wire
        .getSysioContract(SysioContractName.dclaim)
        .tables.capcfg.query(),
      syndicationState = await ctx.wire
        .getSysioContract(SysioContractName.synd)
        .tables.syndstate.query()
    Assert.strictEqual(
      funded,
      claims,
      `LcoImportSteps: sysio.dclaim holds ${funded} WIRE subunits, not the ${claims} its claims need`
    )
    Assert.ok(
      claimConfig.rows[0]?.imported_complete === true,
      "LcoImportSteps: the sysio.dclaim import is not sealed"
    )
    Assert.ok(
      !input.sealsSyndication ||
        syndicationState.rows[0]?.import_complete === true,
      "LcoImportSteps: the sysio.synd import is not sealed"
    )
    Assert.deepStrictEqual(
      await WireSyndicationTool.readMismatches(ctx),
      [],
      "LcoImportSteps: the import left custody mismatches"
    )
    StepExtraRecorder.note("launch-data import verified", {
      claims: claims.toString(),
      pools: WireLcoImportTool.chainPlans(plan).map(
        chainPlan => chainPlan.pool.pairSymbol
      )
    })
  }

  /** The published plan's chain whose depot code is `chainCode`; throws when absent. */
  function assertChainPlan<C extends ClusterBuildContext>(
    ctx: C,
    chainCode: string
  ): WireLcoImportTool.ChainPlan {
    const chainPlan = WireLcoImportTool.chainPlans(
      ctx.outputs.assert(LcoImportPlanKey)
    ).find(candidate => candidate.pool.chainCode === chainCode)
    Assert.ok(
      chainPlan != null,
      `LcoImportSteps: the import plan has no ${chainCode} chain`
    )
    return chainPlan
  }
}
