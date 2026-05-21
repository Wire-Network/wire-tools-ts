/**
 * EthereumSwapTool — user-side helper for triggering Ethereum →
 * other-chain swaps via the Ethereum outpost's `ReserveManager.requestSwap`.
 *
 * Mirrors the {@link depositETHCollateral} shape: stateless, takes a
 * connected `ReserveManager` contract (bound to the user's signer), packs
 * the structured swap parameters, and awaits receipt confirmation.
 *
 * The contract emits `SwapRequested(user, sourceTokenCode, ..., targetAmount,
 * targetToleranceBps)`, increments its own outpost-side reserve balance
 * accounting, and queues a `SWAP_REQUEST` OPP attestation. Batch operators
 * relay the envelope; the depot's `sysio.uwrit::createuwreq` opens a
 * UWREQ row; the underwriter race resolves; a SWAP_REMIT returns inbound
 * on the destination outpost and pays the recipient there.
 *
 * @see ReserveManager.sol:requestSwap
 */

import Assert from "node:assert"
import { ethers } from "ethers"

/**
 * Minimal `ethers` contract surface this helper relies on. Typed structurally
 * so the caller can pass an `ethers.Contract`, a typechain-generated
 * `ReserveManager`, or a compatible mock.
 */
export interface ReserveManagerRequestSwapContract {
  requestSwap: (
    sourceTokenCode: bigint,
    sourceReserveCode: bigint,
    targetChainCode: bigint,
    targetTokenCode: bigint,
    targetReserveCode: bigint,
    targetRecipient: Uint8Array | string,
    targetAmount: bigint,
    targetToleranceBps: number,
    overrides: ethers.Overrides & { value: bigint }
  ) => Promise<ethers.ContractTransactionResponse>
}

/**
 * Structured arguments for a SWAP_REQUEST emission. All slug_name codes
 * are passed as `bigint` so the typechain ABI binding accepts them
 * without lossy `number` conversion (slug_names round-trip cleanly
 * through 2^53, but bigint is the safe shape).
 */
export interface EthereumSwapRequest {
  /** slug_name of the source token on this outpost (must be native this pass). */
  sourceTokenCode: bigint
  /** slug_name of the source reserve. */
  sourceReserveCode: bigint
  /** Wei to escrow into the source reserve and quote as the swap input. */
  sourceAmountWei: bigint
  /** slug_name of the target chain (e.g. `SlugName.from("SOLANA")`). */
  targetChainCode: bigint
  /** slug_name of the target token (e.g. `SlugName.from("SOL")`). */
  targetTokenCode: bigint
  /** slug_name of the target reserve. */
  targetReserveCode: bigint
  /**
   * Raw recipient address on the target chain. 32 bytes for Solana
   * (ed25519 pubkey), 20 bytes for EVM destinations.
   */
  targetRecipient: Uint8Array
  /**
   * User-specified minimum acceptable destination amount in
   * destination-chain base units (e.g. lamports for SOL). The depot's
   * variance check rejects with `SwapRevert` if drift exceeds
   * `targetToleranceBps`.
   */
  targetAmount: bigint
  /** Acceptable variance in basis points (e.g. 50 = 0.5%). */
  targetToleranceBps: number
}

/**
 * Result of a successful `requestSwap` submission.
 */
export interface EthereumSwapResult {
  /** Mined transaction hash. */
  transactionHash: string
  /** Block number containing the request tx. */
  blockNumber: number
  /** Cumulative gas used by the request tx. */
  gasUsed: bigint
}

/**
 * Submit a SWAP_REQUEST emission via the Ethereum outpost.
 *
 * Native ETH only this pass — the contract reverts with
 * `WIRE_SwapSourceNotNative` for non-native source tokens. ERC-20
 * source-side custody lands with the `flow-swap-non-native-tokens`
 * follow-on plan.
 *
 * @param reserveManager Contract bound to the user's signer
 *                        (`contract.connect(wallet)`).
 * @param request        Structured swap parameters.
 * @return Receipt details for cluster-state heartbeat reconciliation.
 * @throws If the tx reverts or the receipt status is non-1.
 */
export async function requestEthereumSwap(
  reserveManager: ReserveManagerRequestSwapContract,
  request: EthereumSwapRequest
): Promise<EthereumSwapResult> {
  Assert.ok(request.sourceAmountWei > 0n,
    "EthereumSwapTool: sourceAmountWei must be > 0")
  Assert.ok(request.targetRecipient.byteLength > 0,
    "EthereumSwapTool: targetRecipient must be non-empty")
  Assert.ok(request.targetAmount > 0n,
    "EthereumSwapTool: targetAmount must be > 0")
  Assert.ok(request.targetToleranceBps >= 0 && request.targetToleranceBps <= 10_000,
    `EthereumSwapTool: targetToleranceBps must be in [0, 10000], got ${request.targetToleranceBps}`)

  const tx = await reserveManager.requestSwap(
    request.sourceTokenCode,
    request.sourceReserveCode,
    request.targetChainCode,
    request.targetTokenCode,
    request.targetReserveCode,
    request.targetRecipient,
    request.targetAmount,
    request.targetToleranceBps,
    { value: request.sourceAmountWei }
  )
  const receipt = await tx.wait()
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `EthereumSwapTool: requestSwap tx reverted (status=${receipt?.status ?? "null"})`
  )
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed
  }
}
