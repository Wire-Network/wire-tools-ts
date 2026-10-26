import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { ClusterFiles, type ClusterConfig } from "@wireio/cluster-tool-shared"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { range, sortBy, sumBy, toLower, upperFirst } from "lodash"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { WireLcoImportTool } from "../../tools/wire/WireLcoImportTool.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { formatWireAsset } from "../../tools/wire/WireUserTool.js"
import { eachSeries } from "../../utils/asyncUtils.js"
import { slugValue } from "../../utils/slugUtils.js"
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

const {
  SysioContractAccount,
  SysioContractName,
  SysioDclaimChainkind,
  SysioSyndChainkind
} = SysioContracts
const { Actor } = Report

/**
 * The launch-data (LCO) import: each outpost's frozen pre-launch export replayed onto the
 * depot during epoch zero — every syndicated position (`sysio.synd::importsynd`), every
 * WIRE claim (`sysio.dclaim::importseed`) and each chain's LCO yield pool
 * (`sysio.liq::regliqpool`), then the claims funded, the claims and positions reconciled,
 * both imports sealed and the result verified. One write per Step; the positions and claims ride the published plan
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

  /** Input for {@link planReconcileClaims}: the claims the seal was composed for. */
  export interface ReconcileClaimsInput extends StepInput {
    readonly kind: "LcoImportSteps.ReconcileClaimsInput"
    /** How many claims the plan imports across every chain. */
    readonly claimCount: number
  }

  /** Input for {@link planReconcileSyndication}: the positions the seals were composed for. */
  export interface ReconcileSyndicationInput extends StepInput {
    readonly kind: "LcoImportSteps.ReconcileSyndicationInput"
    /** How many positions the plan imports across every chain. */
    readonly positionCount: number
  }

  /** One syndicated position as the syndication reconcile compares it. */
  export interface ImportedPosition {
    /** The depot chain code; a row on a chain the plan lacks keeps its raw `chain_kind`. */
    readonly chainCode: string
    /** The liq token code. */
    readonly tokenCode: string
    /** The pubkey, raw-byte hex. */
    readonly pubkey: string
    /** The position, in the liq token's depot subunits. */
    readonly amount: bigint
  }

  /** One `sysio.dclaim::unmapped` claim as the reconcile compares it. */
  export interface UnmappedClaim {
    /** The depot chain code of the claim's chain; a row on a chain the plan lacks keeps its raw `chain_kind`. */
    readonly chainCode: string
    /** The native address, raw-byte hex. */
    readonly nativeAddress: string
    /** The claim, in WIRE subunits. */
    readonly amount: bigint
  }

  /** Input for {@link planVerify}. */
  export interface VerifyInput extends StepInput {
    readonly kind: "LcoImportSteps.VerifyInput"
    /** Whether this import sealed `sysio.synd`'s import. */
    readonly sealsSyndication: boolean
  }

  /**
   * ONE PhaseGroup holding the whole import: the plan and its record, one Phase per
   * exported chain (its position batches, claim batches and pool), and the funding, the
   * claim and position reconciles, the seals and the verify. Must run during epoch zero, after the shadow
   * symbols, the swap and `sysio.dclaim` are configured and before any other mint of an
   * imported shadow. Self-registers on `parent`.
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
      chainPlans = WireLcoImportTool.chainPlans(plan),
      claimTotal = WireLcoImportTool.planClaimTotal(plan),
      claimCount = sumBy(chainPlans, chainPlan => chainPlan.claims.length),
      positionCount = sumBy(
        chainPlans,
        chainPlan => chainPlan.syndications.length
      )
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
    chainPlans.forEach(chainPlan =>
      planChainImport<C>(group, options, chainPlan)
    )
    ClusterBuildPhase.create<C>(
      group,
      "LcoImportSeal",
      "Fund the WIRE claims, reconcile the claims and positions, seal the imports and verify them",
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
        planReconcileClaims<C>(
          Actor.Sysio,
          "reconcile-lco-claims",
          "check that sysio.dclaim::unmapped holds exactly the planned claims before the seal",
          options,
          claimCount
        ),
        planReconcileSyndication<C>(
          Actor.Sysio,
          "reconcile-lco-syndication",
          "check that sysio.synd holds exactly the planned positions before the seals",
          options,
          positionCount
        ),
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
            WireLcoImportTool.batchCreditCount(
              chainPlan.syndications.length,
              WireLcoImportTool.SyndicationBatchSize,
              batchIndex
            )
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
            WireLcoImportTool.batchCreditCount(
              chainPlan.claims.length,
              WireLcoImportTool.ClaimBatchSize,
              batchIndex
            )
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

  /** Reconcile `sysio.dclaim::unmapped` against the plan's claims — the gate before the claim seal. */
  export function planReconcileClaims<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    claimCount: number
  ): ClusterBuildStep<C, ReconcileClaimsInput> {
    return ClusterBuildStep.create<C, ReconcileClaimsInput>(
      actor,
      name,
      description,
      options,
      { kind: "LcoImportSteps.ReconcileClaimsInput", claimCount },
      runReconcileClaims
    )
  }

  /**
   * Named runner — refuse the claim seal unless `sysio.dclaim::unmapped` holds exactly the
   * plan's claims: each planned native address once, at its planned amount, and no other row.
   * `importdone` makes the import final, so a missing or wrong claim must stop it here.
   */
  export async function runReconcileClaims<C extends ClusterBuildContext>(
    ctx: C,
    input: ReconcileClaimsInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const chainPlans = WireLcoImportTool.chainPlans(
        ctx.outputs.assert(LcoImportPlanKey)
      ),
      planned = chainPlans.flatMap(chainPlan =>
        chainPlan.claims.map(claim => ({
          chainCode: chainPlan.pool.chainCode,
          nativeAddress: claim.native_address,
          amount: BigInt(claim.wire_atomic)
        }))
      )
    Assert.strictEqual(
      planned.length,
      input.claimCount,
      `LcoImportSteps: the plan holds ${planned.length} claims, not the ${input.claimCount} the seal was composed for`
    )
    const rows = await ctx.wire
        .getSysioContract(SysioContractName.dclaim)
        .tables.unmapped.queryAll({ limit: WireSyndicationTool.TableRowLimit }),
      imported = rows.map(row => ({
        chainCode: WireLcoImportTool.chainCodeOf(
          chainPlans,
          row.chain_kind,
          SysioDclaimChainkind
        ),
        nativeAddress: row.native_pubkey,
        amount: WireSyndicationTool.assetUnits(row.balance)
      }))
    Assert.deepStrictEqual(
      sortClaims(imported),
      sortClaims(planned),
      "LcoImportSteps: sysio.dclaim::unmapped differs from the planned claims; the claim import stays unsealed"
    )
    StepExtraRecorder.note("launch-data claims reconciled", {
      claims: planned.length
    })
  }

  /** `claims` ordered by chain, then native address — the order the reconcile compares. */
  function sortClaims(claims: UnmappedClaim[]): UnmappedClaim[] {
    return sortBy(claims, [
      claim => claim.chainCode,
      claim => claim.nativeAddress
    ])
  }

  /** Reconcile `sysio.synd` against the plan's positions — the gate before the seals. */
  export function planReconcileSyndication<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    positionCount: number
  ): ClusterBuildStep<C, ReconcileSyndicationInput> {
    return ClusterBuildStep.create<C, ReconcileSyndicationInput>(
      actor,
      name,
      description,
      options,
      { kind: "LcoImportSteps.ReconcileSyndicationInput", positionCount },
      runReconcileSyndication
    )
  }

  /**
   * Named runner — refuse the seals unless `sysio.synd` holds exactly the plan's positions.
   * `importsynd` parks a position whose pubkey has no authex link and mints it to the linked
   * account otherwise, so every `parked` row must be a planned position at its planned
   * amount, and each shadow's outstanding must equal its booked custody: the pool's LCO liq
   * plus every position, parked or minted. A batch pushed twice fails one or the other, and
   * `importdone` would make it final.
   */
  export async function runReconcileSyndication<C extends ClusterBuildContext>(
    ctx: C,
    input: ReconcileSyndicationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const chainPlans = WireLcoImportTool.chainPlans(
        ctx.outputs.assert(LcoImportPlanKey)
      ),
      planned = chainPlans.flatMap(chainPlan =>
        chainPlan.syndications.map(spec => ({
          chainCode: chainPlan.pool.chainCode,
          tokenCode: chainPlan.pool.tokenCode,
          pubkey: WireLcoImportTool.nativeBytesHex(chainPlan.chain, spec.pubkey),
          amount: spec.amount
        }))
      )
    Assert.strictEqual(
      planned.length,
      input.positionCount,
      `LcoImportSteps: the plan holds ${planned.length} positions, not the ${input.positionCount} the seals were composed for`
    )
    const plannedAmounts = new Map(
        planned.map(position => [positionKey(position), position.amount])
      ),
      parked = (
        await ctx.wire
          .getSysioContract(SysioContractName.synd)
          .tables.parked.queryAll({ limit: WireSyndicationTool.TableRowLimit })
      ).map(row => ({
        chainCode: WireLcoImportTool.chainCodeOf(
          chainPlans,
          row.chain_kind,
          SysioSyndChainkind
        ),
        tokenCode: SlugName.toString(slugValue(row.token_code)),
        pubkey: row.pubkey,
        amount: BigInt(row.balance)
      }))
    Assert.deepStrictEqual(
      parked.filter(
        position => plannedAmounts.get(positionKey(position)) !== position.amount
      ),
      [],
      "LcoImportSteps: sysio.synd::parked holds positions the plan does not; the syndication import stays unsealed"
    )
    await eachSeries(chainPlans, async ({ pool }) => {
      const outstanding = await WireSyndicationTool.readOutstanding(
        ctx,
        pool.tokenCode
      )
      Assert.strictEqual(
        outstanding,
        pool.custodyTotal,
        `LcoImportSteps: ${pool.tokenCode} outstanding ${outstanding} differs from its booked custody ${pool.custodyTotal}; the syndication import stays unsealed`
      )
    })
    StepExtraRecorder.note("launch-data positions reconciled", {
      positions: planned.length,
      parked: parked.length
    })
  }

  /** The identity of a position: its token, chain and pubkey. */
  function positionKey(position: ImportedPosition): string {
    return `${position.tokenCode}/${position.chainCode}/${position.pubkey}`
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
   * at least the claims (WIRE it held before the funding stays), the claim import is sealed (and the syndication import when this
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
    Assert.ok(
      funded >= claims,
      `LcoImportSteps: sysio.dclaim holds ${funded} WIRE subunits, less than the ${claims} its claims need`
    )
    // The chain's JSON spells an ABI `bool` as `0` / `1`, never `true` / `false`.
    Assert.ok(
      Boolean(claimConfig.rows[0]?.imported_complete),
      "LcoImportSteps: the sysio.dclaim import is not sealed"
    )
    Assert.ok(
      !input.sealsSyndication ||
        Boolean(syndicationState.rows[0]?.import_complete),
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
