import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import { Constants } from "../../Constants.js"
import type { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../../orchestration/ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../../orchestration/ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import type { LcoImportSteps } from "../../orchestration/steps/LcoImportSteps.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { BatchOperatorKeyTool } from "../../tools/wire/BatchOperatorKeyTool.js"
import { WireLcoImportTool } from "../../tools/wire/WireLcoImportTool.js"
import { WireSyndicationTool } from "../../tools/wire/WireSyndicationTool.js"
import { eachSeries } from "../../utils/asyncUtils.js"

const { SysioContractName } = SysioContracts
const { Actor } = Report

/**
 * Report-visible checks of a PRE-FUNDED launch on a KEY-custody cluster: the bootstrap
 * batch operators' identities were created and persisted BEFORE the cluster
 * (`BatchOperatorKeyTool.createPersisted`), their positions frozen into the launch-data
 * exports under their outpost keys, and the bootstrap ADOPTED exactly those identities
 * (`batchOperatorKeyPolicy: adoptOnly`). Each phase holds one verify Step per operator, so
 * the Report names the operator whose pre-funding did not reach it.
 */
export namespace BatchOperatorPrefundingSteps {
  /**
   * The shadow symbols a pre-funded batch operator holds imported credit in, one per
   * outpost: LIQETH and LIQSOL.
   */
  export const PrefundedTokenCodes: readonly string[] = [
    Constants.liqTokenCode(Constants.ETHEREUM_CHAIN_CODENAME),
    Constants.liqTokenCode(Constants.SOLANA_CHAIN_CODENAME)
  ]

  /** Input of the per-operator verify Steps that need only the operator's handle. */
  export interface OperatorInput extends StepInput {
    readonly kind: "BatchOperatorPrefundingSteps.OperatorInput"
    /** The batch operator's durable handle (`batchop.a`). */
    readonly label: string
  }

  /** Input for {@link planVerifyShadowCredit}: the operator and the shadows it must hold. */
  export interface ShadowCreditInput extends StepInput {
    readonly kind: "BatchOperatorPrefundingSteps.ShadowCreditInput"
    /** The batch operator's durable handle. */
    readonly label: string
    /** The shadow symbols it must hold a positive balance in. */
    readonly tokenCodes: readonly string[]
  }

  // ── Phase: the bootstrap adopted the pre-created identities ──────────────

  /**
   * ONE Phase verifying that the bootstrap adopted every pre-created identity — one Step
   * per operator, self-registered on `parent`: the keys `ctx.keyStore` holds after the
   * bootstrap's `OperatorKeys` phase are the ones persisted under the operator's handle
   * before the cluster existed, so nothing was regenerated in their place.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every Step.
   * @param labels - The pre-created batch operators' durable handles.
   * @returns The self-registered phase.
   */
  export function planVerifyAdoptedIdentities<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    labels: readonly string[]
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      name,
      description,
      labels.map(label =>
        planVerifyAdoptedIdentity<C>(
          Actor.BatchOperator,
          `verify-${label}-adopted-identity`,
          `${label}'s keys in the key store are the ones persisted before the cluster existed`,
          options,
          label
        )
      )
    )
  }

  /** Verify ONE operator's adopted identity against its persisted handles. */
  export function planVerifyAdoptedIdentity<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, OperatorInput> {
    return ClusterBuildStep.create<C, OperatorInput>(
      actor,
      name,
      description,
      options,
      { kind: "BatchOperatorPrefundingSteps.OperatorInput", label },
      runVerifyAdoptedIdentity
    )
  }

  /**
   * Named runner — the key store's identity and the persisted one agree on every public
   * half (the WIRE account key, the Ethereum key and its address, the Solana key) and on
   * the on-chain account. A disagreement names the curve, so a regenerated key points at
   * the materialization that replaced it rather than at a later link or bond that merely
   * finds the wrong identity.
   */
  export async function runVerifyAdoptedIdentity<C extends ClusterBuildContext>(
    ctx: C,
    input: OperatorInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const adopted = ctx.keyStore.assertOperator(input.label),
      [persisted] = BatchOperatorKeyTool.loadPersisted(ctx.config.dataPath, [
        input.label
      ])
    Assert.ok(
      adopted.ethereum != null && adopted.solana != null,
      `BatchOperatorPrefundingSteps: ${input.label} carries no outpost keys`
    )
    Assert.strictEqual(
      adopted.account,
      persisted.account,
      `BatchOperatorPrefundingSteps: ${input.label}'s on-chain account differs from its pre-created identity's`
    )
    Assert.strictEqual(
      adopted.wire.publicKey,
      persisted.wire.publicKey,
      `BatchOperatorPrefundingSteps: ${input.label}'s WIRE key was regenerated instead of adopted`
    )
    Assert.strictEqual(
      adopted.ethereum.publicKey,
      persisted.ethereum.publicKey,
      `BatchOperatorPrefundingSteps: ${input.label}'s Ethereum key was regenerated instead of adopted`
    )
    Assert.strictEqual(
      adopted.ethereum.address,
      persisted.ethereum.address,
      `BatchOperatorPrefundingSteps: ${input.label}'s Ethereum address differs from its pre-created identity's`
    )
    Assert.strictEqual(
      adopted.solana.publicKey,
      persisted.solana.publicKey,
      `BatchOperatorPrefundingSteps: ${input.label}'s Solana key was regenerated instead of adopted`
    )
    StepExtraRecorder.note(`${input.label} adopted its pre-created identity`, {
      label: input.label,
      account: adopted.account,
      wire: adopted.wire.publicKey,
      ethereum: adopted.ethereum.address,
      solana: adopted.solana.publicKey
    })
  }

  // ── Phase: both outpost keys are linked to the operator's account ────────

  /**
   * ONE Phase verifying that every operator's `sysio.authex` links exist for both chains —
   * one Step per operator, self-registered on `parent`. The links are what swept each
   * operator's parked launch-data positions into its own shadow balances.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every Step.
   * @param labels - The batch operators' durable handles.
   * @returns The self-registered phase.
   */
  export function planVerifyAuthexLinks<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    labels: readonly string[]
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      name,
      description,
      labels.map(label =>
        planVerifyAuthexLink<C>(
          Actor.BatchOperator,
          `verify-${label}-authex-links`,
          `${label}'s Ethereum and Solana keys are linked to its account`,
          options,
          label
        )
      )
    )
  }

  /** Verify ONE operator's two `sysio.authex` links. */
  export function planVerifyAuthexLink<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, OperatorInput> {
    return ClusterBuildStep.create<C, OperatorInput>(
      actor,
      name,
      description,
      options,
      { kind: "BatchOperatorPrefundingSteps.OperatorInput", label },
      runVerifyAuthexLink
    )
  }

  /**
   * Named runner — among the `sysio.authex::links` rows of the operator's account, one
   * carries its Ethereum key and one its Solana key, compared in the canonical `PUB_EM_` /
   * `PUB_ED_` spelling (`WireLcoImportTool.linkRowKey`: nodeop renders an EM key
   * uncompressed, the key store holds it compressed).
   */
  export async function runVerifyAuthexLink<C extends ClusterBuildContext>(
    ctx: C,
    input: OperatorInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.label)
    Assert.ok(
      operator.ethereum != null && operator.solana != null,
      `BatchOperatorPrefundingSteps: ${input.label} carries no outpost keys`
    )
    const links = await ctx.wire
        .getSysioContract(SysioContractName.authex)
        .tables.links.queryAll({ limit: WireSyndicationTool.TableRowLimit }),
      linked = links
        .filter(link => link.username === operator.account)
        .map(link => WireLcoImportTool.linkRowKey(link.pub_key))
    Assert.ok(
      linked.includes(operator.ethereum.publicKey),
      `BatchOperatorPrefundingSteps: ${input.label} (${operator.account}) has no sysio.authex link for its Ethereum key ${operator.ethereum.publicKey}`
    )
    Assert.ok(
      linked.includes(operator.solana.publicKey),
      `BatchOperatorPrefundingSteps: ${input.label} (${operator.account}) has no sysio.authex link for its Solana key ${operator.solana.publicKey}`
    )
    StepExtraRecorder.note(`${input.label} is linked on both chains`, {
      label: input.label,
      account: operator.account,
      linked
    })
  }

  // ── Phase: each operator holds its imported shadow credit ────────────────

  /**
   * ONE Phase verifying that every operator holds a positive balance in each pre-funded
   * shadow — one Step per operator, self-registered on `parent`. The named symbols are
   * the flow's own assertion of what pre-funding delivered, independent of the import's
   * published plan.
   *
   * @param parent - The build root or enclosing PhaseGroup.
   * @param name - Short phase name.
   * @param description - Human-readable phase description.
   * @param options - Step option overrides threaded to every Step.
   * @param labels - The batch operators' durable handles.
   * @param tokenCodes - The shadow symbols each operator must hold ({@link PrefundedTokenCodes}).
   * @returns The self-registered phase.
   */
  export function planVerifyShadowCredits<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    labels: readonly string[],
    tokenCodes: readonly string[]
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      name,
      description,
      labels.map(label =>
        planVerifyShadowCredit<C>(
          Actor.BatchOperator,
          `verify-${label}-shadow-credit`,
          `${label} holds a positive ${tokenCodes.join(" and ")} balance from its pre-funded positions`,
          options,
          label,
          tokenCodes
        )
      )
    )
  }

  /** Verify ONE operator's positive balance in each named shadow. */
  export function planVerifyShadowCredit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    tokenCodes: readonly string[]
  ): ClusterBuildStep<C, ShadowCreditInput> {
    return ClusterBuildStep.create<C, ShadowCreditInput>(
      actor,
      name,
      description,
      options,
      { kind: "BatchOperatorPrefundingSteps.ShadowCreditInput", label, tokenCodes },
      runVerifyShadowCredit
    )
  }

  /**
   * Named runner — the operator's `sysio.liq` balance in every named shadow is positive.
   * A zero balance names the shadow, so the failure points at the position that was not
   * exported or the link that did not sweep it.
   */
  export async function runVerifyShadowCredit<C extends ClusterBuildContext>(
    ctx: C,
    input: ShadowCreditInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      input.tokenCodes.length > 0,
      `BatchOperatorPrefundingSteps: ${input.label}'s credit check names no shadow`
    )
    const operator = ctx.keyStore.assertOperator(input.label),
      credits: LcoImportSteps.BatchOperatorCredit[] = []
    await eachSeries(input.tokenCodes, async tokenCode => {
      const balance = await WireSyndicationTool.readLiqBalance(
        ctx,
        operator.account,
        tokenCode
      )
      Assert.ok(
        balance > 0n,
        `BatchOperatorPrefundingSteps: ${input.label} (${operator.account}) holds no ${tokenCode}: its pre-funded position was not exported, or its link did not sweep it`
      )
      credits.push({ tokenCode, balance })
    })
    StepExtraRecorder.note(`${input.label} holds its pre-funded shadow credit`, {
      label: input.label,
      account: operator.account,
      credits: credits.map(credit => ({
        tokenCode: credit.tokenCode,
        balance: credit.balance.toString()
      }))
    })
  }
}
