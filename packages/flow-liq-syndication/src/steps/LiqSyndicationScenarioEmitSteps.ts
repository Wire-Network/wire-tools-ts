/**
 * LiqSyndicationScenarioEmitSteps — Step factories for the flow's synthetic
 * liq-syndication injections. Every injection is its OWN
 * {@link ClusterBuildStep} so the `Report` records it:
 * {@link LiqSyndicationScenarioEmitSteps.planSyndicateLiqEmit} (one
 * `liqsol_core::add_attestation` ix carrying a `SyndicateLiq`) and
 * {@link LiqSyndicationScenarioEmitSteps.planLiqYieldEmit} (the same ix
 * carrying a `LiqYield`). Deployer-keypair and program loading are pure value
 * helpers executed INSIDE the runners.
 *
 * The harness deploys only `liqsol_core` (no liqsol-token / transfer hook /
 * distribution state), so a REAL `synd` / `report_liq_yield` cannot run here —
 * `add_attestation` is the enqueue surface those instructions use, so the
 * downstream path (batch-operator ferry → OPP envelope → depot dispatch) is
 * identical.
 */

import { Keypair } from "@solana/web3.js"
import {
  ClusterBuildStep,
  Report,
  SolanaCollateralTool,
  SolanaFundingTool,
  emitSolanaLiqYield,
  emitSolanaSyndicateLiq,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"

export namespace LiqSyndicationScenarioEmitSteps {
  // ── Step: SYNDICATE_LIQ injection (`liqsol_core::add_attestation`) ────────

  /** Input for {@link planSyndicateLiqEmit} — one `add_attestation` write. */
  export interface SyndicateLiqEmitInput extends StepInput {
    readonly kind: "LiqSyndicationScenarioEmitSteps.SyndicateLiqEmitInput"
    /** SlugName-packed chain code of the emitting Solana outpost. */
    readonly chainCode: bigint
    /** liqSOL syndicated, base units. */
    readonly amount: bigint
    /** Value taken from the outpost's shared liq sequence. */
    readonly sequence: bigint
  }

  /**
   * A single SYNDICATE_LIQ attestation pushed through
   * `liqsol_core::add_attestation`, signed by the outpost deployer keypair
   * (`OutpostConfig.authority` / the liqsol `admin`). The syndicating user is a
   * FRESH keypair generated inside the runner — the depot keeps no per-user
   * state for these types yet, so the flow's envelope-level verify needs no
   * cross-step identity.
   *
   * @param actor - The narrative subject (the Solana outpost emits).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param chainCode - SlugName-packed Solana chain code.
   * @param amount - liqSOL syndicated, base units.
   * @param sequence - Value on the outpost's shared liq sequence.
   * @returns The definition step.
   */
  export function planSyndicateLiqEmit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: bigint,
    amount: bigint,
    sequence: bigint
  ): ClusterBuildStep<C, SyndicateLiqEmitInput> {
    return ClusterBuildStep.create<C, SyndicateLiqEmitInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "LiqSyndicationScenarioEmitSteps.SyndicateLiqEmitInput",
        chainCode,
        amount,
        sequence
      },
      runSyndicateLiqEmit
    )
  }

  /** Named runner — ONE `add_attestation` ix carrying a `SyndicateLiq`. */
  export async function runSyndicateLiqEmit<C extends ClusterBuildContext>(
    ctx: C,
    input: SyndicateLiqEmitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const user = Keypair.generate(),
      authority = SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      program = SolanaCollateralTool.loadOppOutpostProgram(ctx, authority)
    await emitSolanaSyndicateLiq(
      ctx.solana.connection,
      program,
      authority,
      input.chainCode,
      user.publicKey,
      input.amount,
      input.sequence
    )
  }

  // ── Step: LIQ_YIELD injection (`liqsol_core::add_attestation`) ────────────

  /** Input for {@link planLiqYieldEmit} — one `add_attestation` write. */
  export interface LiqYieldEmitInput extends StepInput {
    readonly kind: "LiqSyndicationScenarioEmitSteps.LiqYieldEmitInput"
    /** SlugName-packed chain code of the emitting Solana outpost. */
    readonly chainCode: bigint
    /** liqSOL claimed as yield for the syndicated pool, base units. */
    readonly amount: bigint
    /** Value taken from the outpost's shared liq sequence. */
    readonly sequence: bigint
    /** Outpost-chain epoch the report was taken at (informational). */
    readonly epoch: bigint
  }

  /**
   * A single LIQ_YIELD attestation pushed through
   * `liqsol_core::add_attestation`, signed by the outpost deployer keypair.
   * The report is GLOBAL to the outpost — it carries no user address.
   *
   * @param actor - The narrative subject (the Solana outpost emits).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param chainCode - SlugName-packed Solana chain code.
   * @param amount - liqSOL claimed as yield, base units.
   * @param sequence - Value on the outpost's shared liq sequence.
   * @param epoch - Outpost-chain epoch stamped on the report.
   * @returns The definition step.
   */
  export function planLiqYieldEmit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainCode: bigint,
    amount: bigint,
    sequence: bigint,
    epoch: bigint
  ): ClusterBuildStep<C, LiqYieldEmitInput> {
    return ClusterBuildStep.create<C, LiqYieldEmitInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "LiqSyndicationScenarioEmitSteps.LiqYieldEmitInput",
        chainCode,
        amount,
        sequence,
        epoch
      },
      runLiqYieldEmit
    )
  }

  /** Named runner — ONE `add_attestation` ix carrying a `LiqYield`. */
  export async function runLiqYieldEmit<C extends ClusterBuildContext>(
    ctx: C,
    input: LiqYieldEmitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const authority = SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      program = SolanaCollateralTool.loadOppOutpostProgram(ctx, authority)
    await emitSolanaLiqYield(
      ctx.solana.connection,
      program,
      authority,
      input.chainCode,
      input.amount,
      input.sequence,
      input.epoch
    )
  }
}
