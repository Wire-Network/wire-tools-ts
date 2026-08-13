/**
 * UnderwriterSlashingScenarioSwapSteps — the flow-local Step factory for the
 * ETH→SOL `ReserveManager.requestSwap` writes this scenario submits (one per
 * challengeable commitment). The heavy lifting is the harness's
 * `requestEthereumSwap` + `EthereumCollateralTool` loaders; this file is the
 * per-flow glue every swap flow declares for itself. The target amount is
 * keyed per swap so ONE factory serves both.
 */

import Assert from "node:assert"
import { ethers } from "ethers"
import { getLogger } from "@wireio/shared"
import {
  contractView,
  ClusterBuildStep,
  ClusterConfigProvider,
  EthereumCollateralTool,
  requestEthereumSwap,
  swapUserOutputKey,
  type ClusterBuildStepOptions,
  type OutputKey,
  type Report,
  type ReserveManagerRequestSwapContract,
  type StepInput,
  type SwapScenarioContext
} from "@wireio/cluster-tool"
import { UnderwriterSlashingScenarioConstants as Constants } from "../UnderwriterSlashingScenarioConstants.js"

const log = getLogger(__filename)

export namespace UnderwriterSlashingScenarioSwapSteps {
  /** Input for {@link planRequestSwapEthereum} — the static SWAP_REQUEST
   *  parameters (the quote-computed target rides `targetAmountKey`). */
  export interface RequestSwapEthereumInput extends StepInput {
    readonly kind: "UnderwriterSlashingScenarioSwapSteps.RequestSwapEthereumInput"
    /** Wei to escrow into the source reserve (`msg.value`). */
    readonly sourceAmountWei: bigint
    /** Acceptable variance in basis points. */
    readonly targetToleranceBps: number
  }

  /**
   * A single `ReserveManager.requestSwap(...)` write signed by the swap user —
   * one ETH→SOL SWAP_REQUEST emission (the same leg shape as
   * flow-swap-with-underwriting's Phase A; chain/token/reserve codes are the
   * flow constants).
   */
  export function planRequestSwapEthereum(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    targetAmountKey: OutputKey<bigint>,
    request: Omit<RequestSwapEthereumInput, "kind">
  ): ClusterBuildStep<SwapScenarioContext, RequestSwapEthereumInput> {
    return ClusterBuildStep.create<SwapScenarioContext, RequestSwapEthereumInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "UnderwriterSlashingScenarioSwapSteps.RequestSwapEthereumInput",
        ...request
      },
      async (ctx, input, signal) =>
        runRequestSwapEthereum(ctx, input, signal, targetAmountKey)
    )
  }

  /** Named runner body — bind `ReserveManager` to the swap user's wallet and
   *  perform ONE `requestSwap(...)` write. */
  export async function runRequestSwapEthereum(
    ctx: SwapScenarioContext,
    input: RequestSwapEthereumInput,
    signal: AbortSignal,
    targetAmountKey: OutputKey<bigint>
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const targetAmount = ctx.outputs.assert(targetAmountKey)
    const reserveManager = loadReserveManager(ctx, swapUser.ethereumWallet)
    const result = await requestEthereumSwap(reserveManager, {
      sourceTokenCode: BigInt(Constants.EthereumTokenCode),
      sourceReserveCode: BigInt(Constants.PrimaryReserveCode),
      sourceAmountWei: input.sourceAmountWei,
      targetChainCode: BigInt(Constants.SolanaChainCode),
      targetTokenCode: BigInt(Constants.SolanaTokenCode),
      targetReserveCode: BigInt(Constants.PrimaryReserveCode),
      targetRecipient: swapUser.solanaPublicKeyBytes,
      targetAmount,
      targetToleranceBps: input.targetToleranceBps
    })
    Assert.ok(
      result.transactionHash,
      "UnderwriterSlashingScenarioSwapSteps.requestSwapEthereum: no transaction hash"
    )
    log.info(
      `[uwchal-swap] requestSwap tx=${result.transactionHash} block=${result.blockNumber} target=${targetAmount}`
    )
  }

  /**
   * Resolve the `ReserveManager` contract from the run's deploy artifacts,
   * bound to `wallet` — address from `outpost-addrs.json`, ABI from the
   * hardhat artifact (both via {@link EthereumCollateralTool}'s loaders).
   */
  export function loadReserveManager(
    ctx: SwapScenarioContext,
    wallet: ethers.Signer
  ): ReserveManagerRequestSwapContract {
    const address = EthereumCollateralTool.loadOutpostAddresses(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
    )[Constants.ReserveManagerContractName]
    Assert.ok(
      address != null && /^0x[0-9a-fA-F]{40}$/.test(address),
      `UnderwriterSlashingScenarioSwapSteps: ${Constants.ReserveManagerContractName} not in outpost-addrs.json (got ${address})`
    )
    const abi = EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      Constants.ReserveManagerContractName
    )
    return contractView<ReserveManagerRequestSwapContract>(address, abi, wallet)
  }
}
