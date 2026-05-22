/**
 * ETHCollateralTool — reusable wrapper around the Ethereum-outpost
 * `OperatorRegistry.deposit(...)` collateral-deposit entry point.
 *
 * Centralises the deposit-call shape used by flow tests (and any future
 * tooling) so callers don't repeat the per-token-code argument-shape
 * juggling: the contract's `nativeTokenCode` is paid via `msg.value`;
 * every other registered tokenCode is paid via `transferFrom` (the
 * operator must have pre-approved the outpost contract). For both
 * kinds, the operator's 33-byte compressed secp256k1 pubkey is the
 * `opAddress` the depot resolves through
 * `sysio.authex::links::bypubkey` to identify the operator's WIRE
 * account.
 */

import Assert from "node:assert"
import { ethers } from "ethers"
import { OperatorType } from "@wireio/opp-typescript-models"

import { resolveLatestNonce } from "../util.js"

/**
 * Minimal `ethers` contract surface this helper relies on. Typed
 * structurally so the caller can pass an `ethers.Contract` instance,
 * a typechain-generated `OperatorRegistry`, or any compatible mock —
 * the only contract is that `deposit(...)` returns a transaction
 * response that yields a receipt with `status === 1n` and
 * `nativeTokenCode()` returns the slug_name used for the msg.value
 * branch.
 */
export interface OperatorRegistryDepositContract {
  deposit: (
    operatorType: number,
    compressedPubkey: string | Uint8Array,
    tokenCode: bigint,
    amount: bigint,
    overrides?: ethers.Overrides & { value?: bigint }
  ) => Promise<ethers.ContractTransactionResponse>
  nativeTokenCode: () => Promise<bigint>
}

/**
 * Submit a collateral deposit to the Ethereum outpost's
 * `OperatorRegistry.deposit(...)` and await receipt confirmation.
 *
 * For the contract's `nativeTokenCode`: forwards `amount` as
 * `msg.value`. For every other registered token code: omits
 * `msg.value` and relies on the operator having pre-approved the
 * outpost contract for `amount` of the underlying ERC20 (the contract
 * calls `transferFrom` internally).
 *
 * @param opRegContract    Operator-registry contract bound to the
 *                         operator's signer (`contract.connect(wallet)`).
 * @param operatorType     `OperatorType` numeric enum value (BATCH /
 *                         UNDERWRITER / PRODUCER).
 * @param compressedPubkey 33-byte secp256k1 compressed public key whose
 *                         derived ETH address matches the connected
 *                         signer's address.
 * @param tokenCode        8-byte slug_name (`uint64`) of the deposited
 *                         token (e.g. `SlugName.from("ETH")`).
 * @param amount           Quantity of `tokenCode` (wei for native ETH,
 *                         base units for ERC20s).
 * @return The mined transaction receipt.
 */
export async function depositETHCollateral(
  opRegContract: OperatorRegistryDepositContract,
  operatorType: OperatorType,
  compressedPubkey: Uint8Array,
  tokenCode: bigint,
  amount: bigint
): Promise<ethers.TransactionReceipt> {
  Assert.ok(amount > 0n, "ETHCollateralTool: amount must be positive")
  Assert.ok(
    compressedPubkey.byteLength === 33,
    `ETHCollateralTool: compressedPubkey must be 33 bytes, got ${compressedPubkey.byteLength}`
  )

  const nativeCode = await opRegContract.nativeTokenCode()
  const overrides: ethers.Overrides & { value?: bigint } =
    tokenCode === nativeCode ? { value: amount } : {}

  const nonce = await resolveLatestNonce(opRegContract as unknown as ethers.BaseContract)
  const tx = await opRegContract.deposit(
    operatorType,
    compressedPubkey,
    tokenCode,
    amount,
    { ...overrides, nonce }
  )
  const receipt = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `ETHCollateralTool: deposit tx reverted (status=${receipt?.status ?? "null"})`
  )
  return receipt
}

/**
 * Minimal `ethers` contract surface for the
 * `OperatorRegistry.depositNonNative(...)` entry point and the
 * companion ERC-20 the harness needs to pre-approve before calling.
 */
export interface OperatorRegistryDepositNonNativeContract {
  depositNonNative: (
    chainCode: bigint,
    tokenCode: bigint,
    reserveCode: bigint,
    operatorType: number,
    compressedPubkey: string | Uint8Array,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  getAddress: () => Promise<string>
}

/** Structural surface for an ERC-20 the harness must `approve()`. */
export interface Erc20ApprovableContract {
  approve: (
    spender: string,
    amount: bigint,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  getAddress: () => Promise<string>
}

/**
 * Submit an ERC-20 collateral deposit to the Ethereum outpost's
 * `OperatorRegistry.depositNonNative(...)` and await receipt
 * confirmation. Pre-approves the OperatorRegistry contract for the
 * deposit amount on the underlying ERC-20 (the contract pulls via
 * `transferFrom`).
 *
 * @param opRegContract     OperatorRegistry contract bound to the
 *                          operator's signer.
 * @param erc20Contract     ERC-20 contract for the collateral token,
 *                          bound to the same operator's signer.
 * @param chainCode         8-byte slug_name (`uint64`) of the
 *                          outpost's home chain (e.g.
 *                          `SlugName.from("ETHEREUM")`). Asserted by
 *                          the contract to equal `outpostChainCode`.
 * @param tokenCode         8-byte slug_name of the ERC-20 token.
 * @param reserveCode       8-byte slug_name of the reserve this
 *                          collateral nominally backs. Plumbed onto
 *                          the OPERATOR_ACTION attestation but not
 *                          validated locally.
 * @param operatorType      `OperatorType` numeric enum value.
 * @param compressedPubkey  33-byte secp256k1 compressed pubkey whose
 *                          derived address matches the signer.
 * @param amount            ERC-20 base units to escrow.
 * @return The mined deposit transaction receipt (approve receipt is
 *         confirmed but not returned).
 */
export async function depositETHNonNativeCollateral(
  opRegContract: OperatorRegistryDepositNonNativeContract,
  erc20Contract: Erc20ApprovableContract,
  chainCode: bigint,
  tokenCode: bigint,
  reserveCode: bigint,
  operatorType: OperatorType,
  compressedPubkey: Uint8Array,
  amount: bigint
): Promise<ethers.TransactionReceipt> {
  Assert.ok(amount > 0n, "ETHCollateralTool: amount must be positive")
  Assert.ok(
    compressedPubkey.byteLength === 33,
    `ETHCollateralTool: compressedPubkey must be 33 bytes, got ${compressedPubkey.byteLength}`
  )

  const opRegAddr      = await opRegContract.getAddress()
  const approveNonce   = await resolveLatestNonce(erc20Contract as unknown as ethers.BaseContract)
  const approveTx      = await erc20Contract.approve(opRegAddr, amount, { nonce: approveNonce })
  await approveTx.wait(1)

  const depositNonce   = await resolveLatestNonce(opRegContract as unknown as ethers.BaseContract)
  const tx             = await opRegContract.depositNonNative(
    chainCode,
    tokenCode,
    reserveCode,
    operatorType,
    compressedPubkey,
    amount,
    { nonce: depositNonce }
  )
  const receipt        = await tx.wait(1)
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `ETHCollateralTool: depositNonNative tx reverted (status=${receipt?.status ?? "null"})`
  )
  return receipt
}
