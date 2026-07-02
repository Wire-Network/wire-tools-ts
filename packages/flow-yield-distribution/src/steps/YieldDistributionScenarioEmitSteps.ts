/**
 * YieldDistributionScenarioEmitSteps — Step factories for the flow's synthetic
 * STAKING_REWARD writes. Every emit is its OWN {@link ClusterBuildStep} so the
 * `Report` records it: {@link YieldDistributionScenarioEmitSteps.ethereumEmit}
 * (one `MockYieldEmitter.emitYield(...)` tx), {@link
 * YieldDistributionScenarioEmitSteps.ethereumEmitReplay} (the SAME
 * `external_epoch_ref` re-emitted — the emitter's per-staker monotonic check
 * MUST revert it), and {@link YieldDistributionScenarioEmitSteps.solanaEmit}
 * (one `opp_outpost::add_attestation` ix). Emitter / program / keypair loading
 * are pure value helpers executed INSIDE the runners.
 */

import Assert from "node:assert"
import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import {
  EthereumCollateralTool,
  Report,
  SolanaCollateralTool,
  SolanaFundingTool,
  emitSolanaYield,
  emitYieldBatch,
  loadMockYieldEmitter,
  ClusterBuildStep,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type MockYieldEmitterContract,
  type OutputKey,
  type StepInput
} from "@wireio/test-cluster-tool"
import { YieldDistributionScenarioConstants as Constants } from "../YieldDistributionScenarioConstants.js"

export namespace YieldDistributionScenarioEmitSteps {
  // ── Step: ETH-side STAKING_REWARD (`MockYieldEmitter.emitYield`) ──────────

  /** Input for {@link ethereumEmit} — one `MockYieldEmitter.emitYield(...)` write. */
  export interface EthereumEmitInput extends StepInput {
    readonly kind: "YieldDistributionScenarioEmitSteps.EthereumEmitInput"
    /** Output key holding the staker's ETH wallet (minted by SetupStakers). */
    readonly stakerWalletKey: OutputKey<ethers.HDNodeWallet>
    /** WIRE account the depot credits — `""` parks the reward in `unmapped`. */
    readonly wireAccount: string
    /** Reward in wei (the depot scales via PrecisionLib). */
    readonly rewardAmount: bigint
    /** Informational share-in-bps for the depot's audit logging. */
    readonly shareBps: number
    /** Monotonic-per-staker reference the emitter + depot dedupe against. */
    readonly externalEpochRef: bigint
    /** Informational WIRE epoch index logged on the credit row. */
    readonly rewardEpochIndex: number
  }

  /**
   * A single `MockYieldEmitter.emitYield(...)` STAKING_REWARD write, signed by
   * the run deployer (anvil #0 — holds the AccessManager role granted by
   * `deployLocal.ts`). The attestation lands on OPP's outbound queue and the
   * batch operators ferry it to the depot's `sysio.dclaim::onreward`.
   *
   * @param actor - The narrative subject (the Ethereum outpost emits).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param stakerWalletKey - Output key of the staker's ETH wallet.
   * @param wireAccount - WIRE account to credit (`""` → unmapped park).
   * @param rewardAmount - Reward in wei.
   * @param shareBps - Informational share-in-bps.
   * @param externalEpochRef - Monotonic-per-staker reference.
   * @param rewardEpochIndex - Informational WIRE epoch index.
   * @returns The definition step.
   */
  export function ethereumEmit<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    stakerWalletKey: OutputKey<ethers.HDNodeWallet>,
    wireAccount: string,
    rewardAmount: bigint,
    shareBps: number,
    externalEpochRef: bigint,
    rewardEpochIndex: number
  ): ClusterBuildStep<C, EthereumEmitInput> {
    return ClusterBuildStep.create<C, EthereumEmitInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "YieldDistributionScenarioEmitSteps.EthereumEmitInput",
        stakerWalletKey,
        wireAccount,
        rewardAmount,
        shareBps,
        externalEpochRef,
        rewardEpochIndex
      },
      runEthereumEmit
    )
  }

  /** Named runner — ONE `MockYieldEmitter.emitYield(...)` write for one staker. */
  export async function runEthereumEmit<C extends ClusterBuildContext>(
    ctx: C,
    input: EthereumEmitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const staker = ctx.outputs.assert(input.stakerWalletKey)
    await emitYieldBatch(
      loadEmitter(ctx),
      [
        {
          staker: staker.address,
          wireAccount: input.wireAccount,
          rewardAmount: input.rewardAmount,
          shareBps: input.shareBps
        }
      ],
      input.externalEpochRef,
      input.rewardEpochIndex
    )
  }

  // ── Step: replayed ETH-side emission (same `external_epoch_ref`) ──────────

  /** Input for {@link ethereumEmitReplay} — the replayed-`external_epoch_ref` write attempt. */
  export interface EthereumEmitReplayInput extends StepInput {
    readonly kind: "YieldDistributionScenarioEmitSteps.EthereumEmitReplayInput"
    /** Output key holding the staker's ETH wallet (the linked staker). */
    readonly stakerWalletKey: OutputKey<ethers.HDNodeWallet>
    /** WIRE account of the original emission being replayed. */
    readonly wireAccount: string
    /** Reward in wei (same as the original emission). */
    readonly rewardAmount: bigint
    /** Informational share-in-bps. */
    readonly shareBps: number
    /** Informational WIRE epoch index. */
    readonly rewardEpochIndex: number
  }

  /**
   * Re-emit the staker's LAST `external_epoch_ref` (read back from the emitter's
   * `lastExternalEpochRef`, exactly like the old suite) and assert the tx
   * REVERTS on the per-staker monotonic check. The write is attempted; the
   * revert is the expected outcome, so a replay that LANDS fails the step.
   *
   * @param actor - The narrative subject (the Ethereum outpost emits).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param stakerWalletKey - Output key of the linked staker's ETH wallet.
   * @param wireAccount - WIRE account of the original emission.
   * @param rewardAmount - Reward in wei (same as the original emission).
   * @param shareBps - Informational share-in-bps.
   * @param rewardEpochIndex - Informational WIRE epoch index.
   * @returns The definition step.
   */
  export function ethereumEmitReplay<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    stakerWalletKey: OutputKey<ethers.HDNodeWallet>,
    wireAccount: string,
    rewardAmount: bigint,
    shareBps: number,
    rewardEpochIndex: number
  ): ClusterBuildStep<C, EthereumEmitReplayInput> {
    return ClusterBuildStep.create<C, EthereumEmitReplayInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "YieldDistributionScenarioEmitSteps.EthereumEmitReplayInput",
        stakerWalletKey,
        wireAccount,
        rewardAmount,
        shareBps,
        rewardEpochIndex
      },
      runEthereumEmitReplay
    )
  }

  /** Named runner — attempt ONE replayed `emitYield(...)` write; assert it reverts. */
  export async function runEthereumEmitReplay<C extends ClusterBuildContext>(
    ctx: C,
    input: EthereumEmitReplayInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const staker = ctx.outputs.assert(input.stakerWalletKey)
    const emitter = loadEmitter(ctx)
    // The staker's last processed ref (a read) — the exact value the original
    // emission recorded, so re-submitting it violates strict monotonicity.
    const replayedRef = await emitter.lastExternalEpochRef(staker.address)
    Assert.ok(
      replayedRef > 0n,
      `YieldDistributionScenarioEmitSteps.ethereumEmitReplay: no prior emission recorded for ${staker.address}`
    )
    await Assert.rejects(
      () =>
        emitYieldBatch(
          emitter,
          [
            {
              staker: staker.address,
              wireAccount: input.wireAccount,
              rewardAmount: input.rewardAmount,
              shareBps: input.shareBps
            }
          ],
          replayedRef,
          input.rewardEpochIndex
        ),
      Constants.ReplayRejectionPattern,
      `expected the replayed external_epoch_ref ${replayedRef} to revert on the emitter's monotonic check`
    )
  }

  // ── Step: SOL-side STAKING_REWARD (`opp_outpost::add_attestation`) ────────

  /** Input for {@link solanaEmit} — one `opp_outpost::add_attestation` write. */
  export interface SolanaEmitInput extends StepInput {
    readonly kind: "YieldDistributionScenarioEmitSteps.SolanaEmitInput"
    /** WIRE account the depot credits — `""` parks the reward in `unmapped`. */
    readonly wireAccount: string
    /** Reward in lamports. */
    readonly rewardAmount: bigint
    /** Informational share-in-bps. */
    readonly shareBps: number
    /** SlugName-packed chain code of the Solana outpost. */
    readonly chainCode: bigint
    /** SlugName-packed token code of the reward token. */
    readonly tokenCode: bigint
    /** Monotonic-per-staker reference the depot dedupes against. */
    readonly externalEpochRef: bigint
    /** Informational WIRE epoch index. */
    readonly rewardEpochIndex: number
  }

  /**
   * A single SOL-side STAKING_REWARD pushed through
   * `opp_outpost::add_attestation`, signed by the outpost deployer keypair
   * (`OutpostConfig.authority`). The staker is a FRESH keypair generated inside
   * the runner — it has no authex link, so the depot parks the credit in
   * `unmapped` (the flow's count-based verify needs no cross-step identity).
   *
   * @param actor - The narrative subject (the Solana outpost emits).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param wireAccount - WIRE account to credit (`""` → unmapped park).
   * @param rewardAmount - Reward in lamports.
   * @param shareBps - Informational share-in-bps.
   * @param chainCode - SlugName-packed Solana chain code.
   * @param tokenCode - SlugName-packed reward token code.
   * @param externalEpochRef - Monotonic-per-staker reference.
   * @param rewardEpochIndex - Informational WIRE epoch index.
   * @returns The definition step.
   */
  export function solanaEmit<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireAccount: string,
    rewardAmount: bigint,
    shareBps: number,
    chainCode: bigint,
    tokenCode: bigint,
    externalEpochRef: bigint,
    rewardEpochIndex: number
  ): ClusterBuildStep<C, SolanaEmitInput> {
    return ClusterBuildStep.create<C, SolanaEmitInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "YieldDistributionScenarioEmitSteps.SolanaEmitInput",
        wireAccount,
        rewardAmount,
        shareBps,
        chainCode,
        tokenCode,
        externalEpochRef,
        rewardEpochIndex
      },
      runSolanaEmit
    )
  }

  /** Named runner — ONE `opp_outpost::add_attestation` ix for a new unlinked staker. */
  export async function runSolanaEmit<C extends ClusterBuildContext>(
    ctx: C,
    input: SolanaEmitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const staker = Keypair.generate()
    const authority = SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath)
    const program = SolanaCollateralTool.loadOppOutpostProgram(ctx, authority)
    await emitSolanaYield(
      ctx.solana.connection,
      program,
      authority,
      {
        staker: staker.publicKey,
        wireAccount: input.wireAccount,
        rewardAmount: input.rewardAmount,
        shareBps: input.shareBps
      },
      input.chainCode,
      input.tokenCode,
      input.externalEpochRef,
      input.rewardEpochIndex
    )
  }

  // ── value helpers (artifact loads — executed INSIDE runners) ──────────────

  /**
   * Resolve `MockYieldEmitter` from the run's deploy artifacts, bound to the
   * run deployer signer (anvil #0 — the AccessManager admin `deployLocal.ts`
   * configured). Address from `outpost-addrs.json`; ABI from the hardhat
   * artifact — both via the harness loaders.
   *
   * @param ctx - The build context (supplies `ethereumPath` + the deployer signer).
   * @returns The emitter bound to the deployer.
   */
  export function loadEmitter<C extends ClusterBuildContext>(ctx: C): MockYieldEmitterContract {
    return loadMockYieldEmitter(
      ctx.config.ethereumPath,
      EthereumCollateralTool.loadOutpostAddresses(ctx.config.ethereumDeploymentsPath),
      ctx.ethereum.wallet.signer
    )
  }
}
