/**
 * ETHCollateralTool — reusable wrapper around the Ethereum-outpost
 * `OperatorRegistry.deposit(...)` collateral-deposit entry point.
 *
 * Centralises the deposit-call shape used by flow tests (and any future
 * tooling) so callers don't repeat the per-TokenKind argument-shape
 * juggling: `TOKEN_KIND_ETH` is paid via `msg.value`; `TOKEN_KIND_LIQETH`
 * is paid via `transferFrom` (the operator must have pre-approved this
 * contract). For both kinds, the operator's 33-byte compressed secp256k1
 * pubkey is the `opAddress` the depot resolves through `sysio.authex::
 * links::bypubkey` to identify the operator's WIRE account.
 */

import Assert from "node:assert"
import { ethers } from "ethers"
import { OperatorType, TokenKind } from "@wireio/opp-typescript-models"

/**
 * Minimal `ethers` contract surface this helper relies on. Typed
 * structurally so the caller can pass an `ethers.Contract` instance,
 * a typechain-generated `OperatorRegistry`, or any compatible mock —
 * the only contract is that `deposit(...)` returns a transaction
 * response that yields a receipt with `status === 1n`.
 */
export interface OperatorRegistryDepositContract {
  deposit: (
    operatorType: number,
    compressedPubkey: string | Uint8Array,
    tokenKind: number,
    amount: bigint,
    overrides?: ethers.Overrides & { value?: bigint }
  ) => Promise<ethers.ContractTransactionResponse>
}

/**
 * Submit a collateral deposit to the Ethereum outpost's
 * `OperatorRegistry.deposit(...)` and await receipt confirmation.
 *
 * For ETH: forwards `amount` as `msg.value`. For LIQETH: omits
 * `msg.value` and relies on the operator having pre-approved the
 * outpost contract for `amount` LIQETH (the contract calls
 * `liqETH.transferFrom` internally).
 *
 * @param opRegContract  Operator-registry contract bound to the
 *                       operator's signer (`contract.connect(wallet)`).
 * @param operatorType   `OperatorType` numeric enum value (BATCH /
 *                       UNDERWRITER / PRODUCER).
 * @param compressedPubkey 33-byte secp256k1 compressed public key whose
 *                       derived ETH address matches the connected
 *                       signer's address.
 * @param tokenKind      `TokenKind` numeric enum value
 *                       (ETH / LIQETH).
 * @param amount         Quantity of `tokenKind` (wei for ETH, base
 *                       units for LIQETH).
 * @return The mined transaction receipt.
 */
export async function depositETHCollateral(
  opRegContract: OperatorRegistryDepositContract,
  operatorType: OperatorType,
  compressedPubkey: Uint8Array,
  tokenKind: TokenKind,
  amount: bigint
): Promise<ethers.TransactionReceipt> {
  Assert.ok(amount > 0n, "ETHCollateralTool: amount must be positive")
  Assert.ok(
    compressedPubkey.byteLength === 33,
    `ETHCollateralTool: compressedPubkey must be 33 bytes, got ${compressedPubkey.byteLength}`
  )

  const overrides: ethers.Overrides & { value?: bigint } =
    tokenKind === TokenKind.ETH ? { value: amount } : {}

  const tx = await opRegContract.deposit(
    operatorType,
    compressedPubkey,
    tokenKind,
    amount,
    overrides
  )
  const receipt = await tx.wait()
  Assert.ok(
    receipt !== null && receipt.status === 1,
    `ETHCollateralTool: deposit tx reverted (status=${receipt?.status ?? "null"})`
  )
  return receipt
}
