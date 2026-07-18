import {
  ClusterBuildStep,
  Report,
  SolanaCollateralTool,
  requestEthereumSwap,
  requestSolanaSwapSpl,
  swapUserOutputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type ReserveManagerRequestSwapContract,
  type StepInput
} from "@wireio/cluster-tool"
import { SwapPrivateReservesScenarioArtifacts as Artifacts } from "../SwapPrivateReservesScenarioArtifacts.js"
import { SwapPrivateReservesScenarioConstants as Constants } from "../SwapPrivateReservesScenarioConstants.js"
import { SwapPrivateReservesScenarioOutputs as Outputs } from "../SwapPrivateReservesScenarioOutputs.js"

/**
 * The user-side SWAP_REQUEST writes of the private-pair flow: Phase A's
 * ETH-native `ReserveManager.requestSwap` sourcing the private ETH reserve,
 * Phase B's `opp_outpost::request_swap_spl` sourcing the private USDCSOL
 * reserve, and the private→WIRE exclusion probe. Each runner reads the swap
 * user identity + the phase's computed target from `ctx.outputs` and performs
 * exactly ONE on-chain write.
 */
export namespace SwapPrivateReservesScenarioSwapSteps {
  // ── Step: Phase A — ETH (native) → USDCSOL (SPL) request (write) ─────────

  /** Input for {@link planRequestSwapEthereumToSolana}. */
  export interface RequestSwapEthereumToSolanaInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioSwapSteps.RequestSwapEthereumToSolanaInput"
    /** Wei escrowed into the private ETH reserve as the swap input. */
    readonly sourceWei: bigint
    readonly targetToleranceBps: number
  }

  /**
   * The user calls `ReserveManager.requestSwap` sourcing the private ETH
   * reserve toward the private USDCSOL reserve. The swap USER signs on-chain
   * with the same wallet that created the reserves — but ownership lives with
   * the WIRE account (`privowner`); the user is not the owner of anything here.
   * The target amount comes from the quote step via
   * {@link Outputs.phaseATarget}; SPL recipients ride as the WALLET pubkey —
   * the outpost pays the recipient's ATA (pre-existing via the creator mint).
   */
  export function planRequestSwapEthereumToSolana<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, RequestSwapEthereumToSolanaInput> {
    return ClusterBuildStep.create<C, RequestSwapEthereumToSolanaInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioSwapSteps.RequestSwapEthereumToSolanaInput",
        sourceWei: Constants.SwapAmounts.PhaseASourceWei,
        targetToleranceBps: Constants.Variance.ToleranceBps
      },
      runRequestSwapEthereumToSolana
    )
  }

  /** Named runner — ONE `requestSwap` write against the private pair (A leg). */
  export async function runRequestSwapEthereumToSolana<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: RequestSwapEthereumToSolanaInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const target = ctx.outputs.assert(Outputs.phaseATarget)
    const reserveManager =
      Artifacts.loadReserveManager<ReserveManagerRequestSwapContract>(
        ctx,
        swapUser.ethereumWallet
      )
    await requestEthereumSwap(reserveManager, {
      sourceTokenCode: BigInt(Constants.Reserves.Ethereum.TokenCode),
      sourceReserveCode: BigInt(Constants.Reserves.PrivateReserveCode),
      sourceAmountWei: input.sourceWei,
      targetChainCode: BigInt(Constants.Reserves.Solana.ChainCode),
      targetTokenCode: BigInt(Constants.Reserves.Solana.TokenCode),
      targetReserveCode: BigInt(Constants.Reserves.PrivateReserveCode),
      targetRecipient: swapUser.solanaPublicKeyBytes,
      targetAmount: target,
      targetToleranceBps: input.targetToleranceBps
    })
  }

  // ── Step: Phase B — USDCSOL (SPL) → ETH (native) request (write) ─────────

  /** Input for {@link planRequestSwapSolanaToEthereum}. */
  export interface RequestSwapSolanaToEthereumInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioSwapSteps.RequestSwapSolanaToEthereumInput"
    /** USDCSOL base units drawn from the creator's ATA as the swap input. */
    readonly sourceSplUnits: bigint
    readonly targetToleranceBps: number
  }

  /**
   * The user calls `opp_outpost::request_swap_spl` sourcing the private
   * USDCSOL reserve toward the private ETH reserve. The target amount comes
   * from the inverse quote step via {@link Outputs.phaseBTarget}; the payout
   * recipient is the user's raw 20-byte ETH address.
   */
  export function planRequestSwapSolanaToEthereum<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, RequestSwapSolanaToEthereumInput> {
    return ClusterBuildStep.create<C, RequestSwapSolanaToEthereumInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioSwapSteps.RequestSwapSolanaToEthereumInput",
        sourceSplUnits: Constants.SwapAmounts.PhaseBSourceSplUnits,
        targetToleranceBps: Constants.Variance.ToleranceBps
      },
      runRequestSwapSolanaToEthereum
    )
  }

  /** Named runner — ONE `request_swap_spl` write against the private pair (B leg). */
  export async function runRequestSwapSolanaToEthereum<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: RequestSwapSolanaToEthereumInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const target = ctx.outputs.assert(Outputs.phaseBTarget)
    await requestSolanaSwapSpl(
      ctx.solana.connection,
      SolanaCollateralTool.loadOppOutpostProgram(ctx, swapUser.solanaKeypair),
      swapUser.solanaKeypair,
      {
        sourceTokenCode: BigInt(Constants.Reserves.Solana.TokenCode),
        sourceReserveCode: BigInt(Constants.Reserves.PrivateReserveCode),
        sourceAmount: input.sourceSplUnits,
        sourceMint: Artifacts.loadUsdcSolMint(ctx),
        targetChainCode: BigInt(Constants.Reserves.Ethereum.ChainCode),
        targetTokenCode: BigInt(Constants.Reserves.Ethereum.TokenCode),
        targetReserveCode: BigInt(Constants.Reserves.PrivateReserveCode),
        targetRecipient: swapUser.ethereumAddressBytes,
        targetAmount: target,
        targetToleranceBps: input.targetToleranceBps
      }
    )
  }

  // ── Step: private → WIRE exclusion probe request (write) ─────────────────

  /** Input for {@link planRequestSwapPrivateToWire}. */
  export interface RequestSwapPrivateToWireInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioSwapSteps.RequestSwapPrivateToWireInput"
    /** Wei escrowed as the probe's source deposit (refunded by the SWAP_REVERT). */
    readonly sourceWei: bigint
    /** The WIRE recipient account name riding the request as bytes. */
    readonly recipientName: string
    /** Positive sentinel — the privacy gate precedes the variance check. */
    readonly targetAmount: bigint
    readonly targetToleranceBps: number
  }

  /**
   * The user requests a swap sourcing the private ETH reserve toward the WIRE
   * endpoint. The depot's privacy gate MUST reject it (SWAP_REVERT, no UWREQ)
   * — the request itself still lands on the outpost, which is why this is a
   * write step; the negative assertions live in the phase's verify steps.
   */
  export function planRequestSwapPrivateToWire<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, RequestSwapPrivateToWireInput> {
    return ClusterBuildStep.create<C, RequestSwapPrivateToWireInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioSwapSteps.RequestSwapPrivateToWireInput",
        sourceWei: Constants.WireProbe.SourceEthereumWei,
        recipientName: Constants.WireProbe.RecipientName,
        targetAmount: Constants.WireProbe.TargetAmount,
        targetToleranceBps: Constants.WireProbe.ToleranceBps
      },
      runRequestSwapPrivateToWire
    )
  }

  /** Named runner — ONE `requestSwap` write targeting the WIRE endpoint. */
  export async function runRequestSwapPrivateToWire<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: RequestSwapPrivateToWireInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const reserveManager =
      Artifacts.loadReserveManager<ReserveManagerRequestSwapContract>(
        ctx,
        swapUser.ethereumWallet
      )
    await requestEthereumSwap(reserveManager, {
      sourceTokenCode: BigInt(Constants.Reserves.Ethereum.TokenCode),
      sourceReserveCode: BigInt(Constants.Reserves.PrivateReserveCode),
      sourceAmountWei: input.sourceWei,
      targetChainCode: BigInt(Constants.Reserves.Wire.ChainCode),
      targetTokenCode: BigInt(Constants.Reserves.Wire.TokenCode),
      targetReserveCode: BigInt(Constants.Reserves.Wire.SentinelReserveCode),
      targetRecipient: new TextEncoder().encode(input.recipientName),
      targetAmount: input.targetAmount,
      targetToleranceBps: input.targetToleranceBps
    })
  }
}
