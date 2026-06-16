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

import { resolveLatestNonce } from "../util.js"

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

  const nonce = await resolveLatestNonce(reserveManager as unknown as ethers.BaseContract)
  const tx = await reserveManager.requestSwap(
    request.sourceTokenCode,
    request.sourceReserveCode,
    request.targetChainCode,
    request.targetTokenCode,
    request.targetReserveCode,
    request.targetRecipient,
    request.targetAmount,
    request.targetToleranceBps,
    { value: request.sourceAmountWei, nonce }
  )
  const receipt = await tx.wait(1)
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

// ─────────────────────────────────────────────────────────────────────
//  ERC-20 source-side swap helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * EIP-2612 permit signature bundle ready to pass into
 * `ReserveManager.requestSwapErc20WithPermit` (struct `PermitSig`).
 * Matches the on-chain layout: `(deadline, v, r, s)`.
 */
export interface EthereumPermitSig {
  /** Permit deadline (unix seconds). */
  deadline: bigint
  /** Recovery id from the signature. */
  v: number
  /** Signature r component. */
  r: string
  /** Signature s component. */
  s: string
}

/**
 * Calldata-facing `SwapArgs` struct that mirrors
 * `ReserveManagerLib.SwapArgs` on the contract. Carries `sourceAmount`
 * directly (in chain-native token units — 6-decimal base units for
 * USDC/USDT, 18-decimal wei for LIQETH).
 */
export interface EthereumSwapArgs {
  sourceTokenCode: bigint
  sourceReserveCode: bigint
  sourceAmount: bigint
  targetChainCode: bigint
  targetTokenCode: bigint
  targetReserveCode: bigint
  targetRecipient: Uint8Array
  targetAmount: bigint
  targetToleranceBps: number
}

/** Structural surface for the new ERC-20 entry points. */
export interface ReserveManagerErc20SwapContract {
  requestSwapErc20WithPermit: (
    args: EthereumSwapArgs,
    permitSig: EthereumPermitSig,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  requestSwapErc20WithApproval: (
    args: EthereumSwapArgs,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
}

/**
 * Submit a SWAP_REQUEST emission for an ERC-20 source token via inline
 * EIP-2612 permit. The whole call is atomic: permit + transferFrom +
 * fee-on-transfer guard + outbound queue all happen in a single tx.
 *
 * Used by `flow-swap-non-native-tokens` for USDC / USDT / LIQETH source
 * legs. Native-ETH source still flows through `requestEthereumSwap`.
 */
export async function requestEthereumSwapErc20WithPermit(
  reserveManager: ReserveManagerErc20SwapContract,
  args: EthereumSwapArgs,
  permitSig: EthereumPermitSig
): Promise<EthereumSwapResult> {
  Assert.ok(args.sourceAmount > 0n,
    "EthereumSwapTool: sourceAmount must be > 0")
  Assert.ok(args.targetRecipient.byteLength > 0,
    "EthereumSwapTool: targetRecipient must be non-empty")
  Assert.ok(args.targetAmount > 0n,
    "EthereumSwapTool: targetAmount must be > 0")
  Assert.ok(args.targetToleranceBps >= 0 && args.targetToleranceBps <= 10_000,
    `EthereumSwapTool: targetToleranceBps must be in [0, 10000], got ${args.targetToleranceBps}`)

  const nonce = await resolveLatestNonce(reserveManager as unknown as ethers.BaseContract)
  const tx = await reserveManager.requestSwapErc20WithPermit(args, permitSig, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `EthereumSwapTool: requestSwapErc20WithPermit tx reverted (status=${receipt?.status ?? "null"})`
  )
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed
  }
}

/**
 * Submit a SWAP_REQUEST emission for an ERC-20 source token via a
 * pre-set allowance. Production fallback for legacy ERC-20s that don't
 * implement EIP-2612 (mainnet USDT, etc.). Caller MUST have already
 * called `IERC20(sourceToken).approve(reserveManager, sourceAmount)` in
 * a prior transaction.
 */
export async function requestEthereumSwapErc20WithApproval(
  reserveManager: ReserveManagerErc20SwapContract,
  args: EthereumSwapArgs
): Promise<EthereumSwapResult> {
  Assert.ok(args.sourceAmount > 0n,
    "EthereumSwapTool: sourceAmount must be > 0")
  Assert.ok(args.targetRecipient.byteLength > 0,
    "EthereumSwapTool: targetRecipient must be non-empty")
  Assert.ok(args.targetAmount > 0n,
    "EthereumSwapTool: targetAmount must be > 0")
  Assert.ok(args.targetToleranceBps >= 0 && args.targetToleranceBps <= 10_000,
    `EthereumSwapTool: targetToleranceBps must be in [0, 10000], got ${args.targetToleranceBps}`)

  const nonce = await resolveLatestNonce(reserveManager as unknown as ethers.BaseContract)
  const tx = await reserveManager.requestSwapErc20WithApproval(args, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `EthereumSwapTool: requestSwapErc20WithApproval tx reverted (status=${receipt?.status ?? "null"})`
  )
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed
  }
}

// ─────────────────────────────────────────────────────────────────────
//  ERC-20 reserve-create helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Calldata-facing `ReserveCreateArgs` struct mirroring
 * `ReserveManagerLib.ReserveCreateArgs` on the contract.
 *
 * `externalTokenAmount` is RAW chain-native units (the escrow the
 * contract takes custody of); the outpost converts it to the depot
 * 9-decimal frame at the boundary for the RESERVE_CREATE attestation's
 * `ReserveAmount` — callers never pre-scale.
 */
export interface EthereumReserveCreateArgs {
  tokenCode: bigint
  reserveCode: bigint
  externalTokenAmount: bigint
  requestedWireAmount: bigint
  connectorWeightBps: number
  name: string
  description: string
  /** Private reserves pair only with same-owner counterparts. */
  isPrivate: boolean
  /**
   * The caller's 33-byte compressed secp256k1 public key (hex) — the
   * contract verifies it derives to the sending wallet, and the depot
   * resolves the creator's authex link from it.
   */
  creatorPubKey: string
}

/** Structural surface for the ERC-20 reserve-create entries. */
export interface ReserveManagerErc20ReserveCreateContract {
  requestReserveCreateErc20WithPermit: (
    args: EthereumReserveCreateArgs,
    permitSig: EthereumPermitSig,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  requestReserveCreateErc20WithApproval: (
    args: EthereumReserveCreateArgs,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
}

/**
 * Open a new ERC-20 reserve on the Ethereum outpost via inline
 * EIP-2612 permit. Permissionless — any user can call.
 *
 * Funds escrow into the contract atomically with the permit consumption
 * and the RESERVE_CREATE outbound attestation queue. The depot's
 * `sysio.reserv::oncrtreserve` handler inserts the depot-side row;
 * subsequent depot `match` action flips status to ACTIVE and emits
 * RESERVE_READY back, which the outpost handles inline.
 */
export async function requestEthereumReserveCreateErc20WithPermit(
  reserveManager: ReserveManagerErc20ReserveCreateContract,
  args: EthereumReserveCreateArgs,
  permitSig: EthereumPermitSig
): Promise<EthereumSwapResult> {
  Assert.ok(args.externalTokenAmount > 0n,
    "EthereumSwapTool: externalTokenAmount must be > 0")
  Assert.ok(args.reserveCode !== 0n,
    "EthereumSwapTool: reserveCode must be non-zero")

  const nonce = await resolveLatestNonce(reserveManager as unknown as ethers.BaseContract)
  const tx = await reserveManager.requestReserveCreateErc20WithPermit(args, permitSig, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `EthereumSwapTool: requestReserveCreateErc20WithPermit tx reverted (status=${receipt?.status ?? "null"})`
  )
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed
  }
}

/**
 * Open a new ERC-20 reserve via a pre-set allowance. Companion to
 * `requestEthereumReserveCreateErc20WithPermit` for legacy ERC-20s
 * that don't implement EIP-2612.
 */
export async function requestEthereumReserveCreateErc20WithApproval(
  reserveManager: ReserveManagerErc20ReserveCreateContract,
  args: EthereumReserveCreateArgs
): Promise<EthereumSwapResult> {
  Assert.ok(args.externalTokenAmount > 0n,
    "EthereumSwapTool: externalTokenAmount must be > 0")
  Assert.ok(args.reserveCode !== 0n,
    "EthereumSwapTool: reserveCode must be non-zero")

  const nonce = await resolveLatestNonce(reserveManager as unknown as ethers.BaseContract)
  const tx = await reserveManager.requestReserveCreateErc20WithApproval(args, { nonce })
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `EthereumSwapTool: requestReserveCreateErc20WithApproval tx reverted (status=${receipt?.status ?? "null"})`
  )
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed
  }
}
