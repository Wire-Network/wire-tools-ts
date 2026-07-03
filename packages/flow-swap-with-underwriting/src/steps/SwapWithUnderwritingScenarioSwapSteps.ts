/**
 * SwapWithUnderwritingScenarioSwapSteps — the flow-local Step factories for the
 * two SWAP_REQUEST writes this scenario submits. Every on-chain WRITE is its
 * own {@link ClusterBuildStep} so the `Report` records it:
 * {@link SwapWithUnderwritingScenarioSwapSteps.requestSwapEthereum} (one
 * `ReserveManager.requestSwap` tx) and
 * {@link SwapWithUnderwritingScenarioSwapSteps.requestSwapSolana} (one
 * `opp_outpost::request_swap` ix). Each runner resolves the swap user's
 * identity + the quote-computed target amount from `ctx.outputs` and performs
 * exactly ONE write via the harness swap tools.
 */

import Assert from "node:assert"
import { ethers } from "ethers"
import { getLogger } from "@wireio/shared"
import {
  contractView,
  ClusterBuildStep,
  EthereumCollateralTool,
  SolanaCollateralTool,
  requestEthereumSwap,
  requestSolanaSwap,
  swapUserOutputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type Report,
  type ReserveManagerRequestSwapContract,
  type StepInput
} from "@wireio/test-cluster-tool"
import { SwapWithUnderwritingScenarioConstants as Constants } from "../SwapWithUnderwritingScenarioConstants.js"

const log = getLogger(__filename)

export namespace SwapWithUnderwritingScenarioSwapSteps {
  // ── Step: Phase A SWAP_REQUEST (`ReserveManager.requestSwap`) ─────────────

  /**
   * Input for {@link planRequestSwapEthereum} — the static SWAP_REQUEST parameters.
   * The target amount rides {@link SwapWithUnderwritingScenarioConstants.PhaseATargetAmountKey}
   * and the recipient is the swap user's SOL pubkey (both resolved from
   * `ctx.outputs` at run time).
   */
  export interface RequestSwapEthereumInput extends StepInput {
    readonly kind: "SwapWithUnderwritingScenarioSwapSteps.RequestSwapEthereumInput"
    /** slug_name of the source token on the Ethereum outpost (native `ETH`). */
    readonly sourceTokenCode: bigint
    /** slug_name of the source reserve. */
    readonly sourceReserveCode: bigint
    /** Wei to escrow into the source reserve (`msg.value`). */
    readonly sourceAmountWei: bigint
    /** slug_name of the target chain (`SOLANA`). */
    readonly targetChainCode: bigint
    /** slug_name of the target token (`SOL`). */
    readonly targetTokenCode: bigint
    /** slug_name of the target reserve. */
    readonly targetReserveCode: bigint
    /** Acceptable variance in basis points. */
    readonly targetToleranceBps: number
  }

  /**
   * A single `ReserveManager.requestSwap(...)` write, signed by the swap
   * user's Ethereum wallet — the Phase A (Ethereum → Solana) SWAP_REQUEST
   * emission.
   *
   * @param actor - The narrative subject (the swap user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param request - The static swap parameters ({@link RequestSwapEthereumInput} minus `kind`).
   * @returns The definition step.
   */
  export function planRequestSwapEthereum<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    request: Omit<RequestSwapEthereumInput, "kind">
  ): ClusterBuildStep<C, RequestSwapEthereumInput> {
    return ClusterBuildStep.create<C, RequestSwapEthereumInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapWithUnderwritingScenarioSwapSteps.RequestSwapEthereumInput", ...request },
      runRequestSwapEthereum
    )
  }

  /**
   * Named runner — bind `ReserveManager` to the swap user's wallet and perform
   * ONE `requestSwap(...)` write. The receipt assertion (mined, status=1) lives
   * in {@link requestEthereumSwap}.
   */
  export async function runRequestSwapEthereum<C extends ClusterBuildContext>(
    ctx: C,
    input: RequestSwapEthereumInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const targetAmount = ctx.outputs.assert(Constants.PhaseATargetAmountKey)
    const reserveManager = loadReserveManager(ctx, swapUser.ethereumWallet)
    const result = await requestEthereumSwap(reserveManager, {
      sourceTokenCode: input.sourceTokenCode,
      sourceReserveCode: input.sourceReserveCode,
      sourceAmountWei: input.sourceAmountWei,
      targetChainCode: input.targetChainCode,
      targetTokenCode: input.targetTokenCode,
      targetReserveCode: input.targetReserveCode,
      targetRecipient: swapUser.solanaPublicKeyBytes,
      targetAmount,
      targetToleranceBps: input.targetToleranceBps
    })
    Assert.ok(
      result.transactionHash,
      "SwapWithUnderwritingScenarioSwapSteps.requestSwapEthereum: no transaction hash"
    )
    log.info(
      `[PhaseA] requestSwap tx=${result.transactionHash} block=${result.blockNumber} target=${targetAmount}`
    )
  }

  // ── Step: Phase B SWAP_REQUEST (`opp_outpost::request_swap`) ──────────────

  /**
   * Input for {@link planRequestSwapSolana} — the static SWAP_REQUEST parameters.
   * The depot-frame target amount rides
   * {@link SwapWithUnderwritingScenarioConstants.PhaseBTargetAmountDepotKey}
   * and the recipient is the swap user's ETH address bytes (both resolved from
   * `ctx.outputs` at run time).
   */
  export interface RequestSwapSolanaInput extends StepInput {
    readonly kind: "SwapWithUnderwritingScenarioSwapSteps.RequestSwapSolanaInput"
    /** slug_name of the source token on the Solana outpost (native `SOL`). */
    readonly sourceTokenCode: bigint
    /** slug_name of the source reserve. */
    readonly sourceReserveCode: bigint
    /** Lamports to escrow into the source reserve. */
    readonly sourceAmount: bigint
    /** slug_name of the target chain (`ETHEREUM`). */
    readonly targetChainCode: bigint
    /** slug_name of the target token (`ETH`). */
    readonly targetTokenCode: bigint
    /** slug_name of the target reserve. */
    readonly targetReserveCode: bigint
    /** Acceptable variance in basis points. */
    readonly targetToleranceBps: number
  }

  /**
   * A single `opp_outpost::request_swap` ix, signed by the swap user's Solana
   * keypair — the Phase B (Solana → Ethereum) SWAP_REQUEST emission.
   *
   * @param actor - The narrative subject (the swap user).
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning (e.g. `timeoutMs`).
   * @param request - The static swap parameters ({@link RequestSwapSolanaInput} minus `kind`).
   * @returns The definition step.
   */
  export function planRequestSwapSolana<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    request: Omit<RequestSwapSolanaInput, "kind">
  ): ClusterBuildStep<C, RequestSwapSolanaInput> {
    return ClusterBuildStep.create<C, RequestSwapSolanaInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapWithUnderwritingScenarioSwapSteps.RequestSwapSolanaInput", ...request },
      runRequestSwapSolana
    )
  }

  /**
   * Named runner — bind the `opp_outpost` program to the swap user's keypair
   * and perform ONE `request_swap` write. Signature confirmation lives in
   * {@link requestSolanaSwap}.
   */
  export async function runRequestSwapSolana<C extends ClusterBuildContext>(
    ctx: C,
    input: RequestSwapSolanaInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const targetAmount = ctx.outputs.assert(Constants.PhaseBTargetAmountDepotKey)
    const program = SolanaCollateralTool.loadOppOutpostProgram(ctx, swapUser.solanaKeypair)
    const signature = await requestSolanaSwap(
      ctx.solana.connection,
      program,
      swapUser.solanaKeypair,
      {
        sourceTokenCode: input.sourceTokenCode,
        sourceReserveCode: input.sourceReserveCode,
        sourceAmount: input.sourceAmount,
        targetChainCode: input.targetChainCode,
        targetTokenCode: input.targetTokenCode,
        targetReserveCode: input.targetReserveCode,
        targetRecipient: swapUser.ethereumAddressBytes,
        targetAmount,
        targetToleranceBps: input.targetToleranceBps
      }
    )
    Assert.ok(
      signature,
      "SwapWithUnderwritingScenarioSwapSteps.requestSwapSolana: no transaction signature"
    )
    log.info(`[PhaseB] request_swap sig=${signature} target=${targetAmount}`)
  }

  // ── value helpers (artifact loads — executed INSIDE runners) ──────────────

  /**
   * Resolve the `ReserveManager` contract from the run's deploy artifacts,
   * bound to `wallet` — address from `outpost-addrs.json`, ABI from the
   * hardhat artifact (both via {@link EthereumCollateralTool}'s loaders).
   *
   * @param ctx - The build context (supplies `config.ethereumPath`).
   * @param wallet - The signer to bind (the swap user's wallet).
   * @returns The bound `requestSwap` contract surface.
   */
  export function loadReserveManager<C extends ClusterBuildContext>(
    ctx: C,
    wallet: ethers.Signer
  ): ReserveManagerRequestSwapContract {
    const address = EthereumCollateralTool.loadOutpostAddresses(ctx.config.ethereumDeploymentsPath)[
      Constants.ReserveManagerContractName
    ]
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `SwapWithUnderwritingScenarioSwapSteps: ${Constants.ReserveManagerContractName} not in outpost-addrs.json (got ${address})`
    )
    const abi = EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      Constants.ReserveManagerContractName
    )
    return contractView<ReserveManagerRequestSwapContract>(address, abi, wallet)
  }
}
