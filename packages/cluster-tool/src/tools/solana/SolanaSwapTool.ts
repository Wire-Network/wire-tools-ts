/**
 * SolanaSwapTool — user-side helper for triggering Solana →
 * other-chain swaps via the Solana outpost's `opp-outpost::request_swap`
 * instruction.
 *
 * Mirrors the {@link depositSOLCollateral} pattern: resolves the program's
 * expected PDAs (`config`, `outbound_message_buffer`, `reserve`), submits
 * the `request_swap` ix signed by the user, and confirms the signature
 * via the same `getSignatureStatus` polling loop the rest of the harness
 * uses.
 *
 * The instruction transfers `sourceAmount` lamports from the user into
 * the per-`(sourceTokenCode, sourceReserveCode)` Reserve PDA (native
 * escrow), credits the on-chain `Reserve.external_token_amount`, and
 * queues a `SWAP_REQUEST` attestation onto the outbound buffer. The
 * matching SwapRemit returns inbound on the destination outpost and
 * pays the recipient there.
 *
 * @see request_swap.rs
 */

import Assert from "node:assert"
import * as anchor from "@coral-xyz/anchor"
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"

/** PDA seeds — kept in sync with `wire-solana/programs/liqsol-core/src/states/opp_states.rs`. */
const OUTPOST_CONFIG_SEED          = Buffer.from("outpost_config")
const OUTBOUND_MESSAGE_BUFFER_SEED = Buffer.from("outbound_message_buffer")
const RESERVE_SEED                 = Buffer.from("reserve")
const RESERVE_VAULT_SEED           = Buffer.from("reserve_vault")

/**
 * Structured arguments for a SOL-source SWAP_REQUEST emission. All
 * slug_name codes are passed as `bigint`; Anchor's IDL handler wraps
 * them in `anchor.BN` for Borsh encoding.
 */
export interface SolanaSwapRequest {
  sourceTokenCode:    bigint
  sourceReserveCode:  bigint
  /** Lamports to escrow into the source reserve. */
  sourceAmount:       bigint
  targetChainCode:    bigint
  targetTokenCode:    bigint
  targetReserveCode:  bigint
  /**
   * Raw recipient address on the target chain. 20 bytes for EVM,
   * 32 bytes for SVM destinations.
   */
  targetRecipient:    Uint8Array
  targetAmount:       bigint
  targetToleranceBps: number
}

/**
 * Submit a SOL → other-chain SWAP_REQUEST via the Solana outpost's
 * `request_swap` ix.
 *
 * Native SOL only this pass — non-native source tokens revert with
 * `SwapSourceNotNative`. SPL source-side custody lands with the
 * `flow-swap-non-native-tokens` follow-on plan.
 *
 * @param connection RPC connection (typically `solClient.connection`).
 * @param program    Anchor program bound to the deployed `opp_outpost` IDL.
 * @param user       Keypair signing the swap. Must hold at least
 *                   `sourceAmount` lamports plus tx fees.
 * @param request    Structured swap parameters.
 * @return The transaction signature on confirm.
 */
export async function requestSolanaSwap(
  connection: Connection,
  program:    anchor.Program<anchor.Idl>,
  user:       Keypair,
  request:    SolanaSwapRequest
): Promise<string> {
  Assert.ok(request.sourceAmount > 0n,
    "SolanaSwapTool: sourceAmount must be > 0")
  Assert.ok(request.targetRecipient.byteLength > 0,
    "SolanaSwapTool: targetRecipient must be non-empty")
  Assert.ok(request.targetAmount > 0n,
    "SolanaSwapTool: targetAmount must be > 0")
  Assert.ok(
    request.targetToleranceBps >= 0 && request.targetToleranceBps <= 10_000,
    `SolanaSwapTool: targetToleranceBps must be in [0, 10000], got ${request.targetToleranceBps}`
  )

  const programId                  = program.programId
  const [configPda]                = PublicKey.findProgramAddressSync([OUTPOST_CONFIG_SEED], programId)
  const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync([OUTBOUND_MESSAGE_BUFFER_SEED], programId)

  // Reserve PDA — derived from `RESERVE_SEED` + LE-encoded source codes.
  const sourceTokenCodeLE   = toU64LeBuffer(request.sourceTokenCode)
  const sourceReserveCodeLE = toU64LeBuffer(request.sourceReserveCode)
  const [reservePda] = PublicKey.findProgramAddressSync(
    [RESERVE_SEED, sourceTokenCodeLE, sourceReserveCodeLE],
    programId
  )

  const tx = await program.methods
    .requestSwap(
      new anchor.BN(request.sourceTokenCode.toString()),
      new anchor.BN(request.sourceReserveCode.toString()),
      new anchor.BN(request.sourceAmount.toString()),
      new anchor.BN(request.targetChainCode.toString()),
      new anchor.BN(request.targetTokenCode.toString()),
      new anchor.BN(request.targetReserveCode.toString()),
      Buffer.from(request.targetRecipient),
      new anchor.BN(request.targetAmount.toString()),
      request.targetToleranceBps
    )
    .accounts({
      user:                  user.publicKey,
      config:                configPda,
      reserve:               reservePda,
      outboundMessageBuffer: outboundMessageBufferPda,
      systemProgram:         SystemProgram.programId
    })
    .signers([user])
    .transaction()

  const sig = await connection.sendTransaction(tx, [user], { skipPreflight: false })
  await confirmSignature(connection, sig, "SolanaSwapTool request_swap")
  return sig
}

/**
 * Encode a `bigint` slug_name as an 8-byte little-endian Buffer matching
 * the program's `to_le_bytes()` seed derivation.
 */
function toU64LeBuffer(value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(value)
  return buf
}

/**
 * Structured arguments for a SPL-source SWAP_REQUEST emission. The
 * source `mint` is looked up against `OutpostConfig.token_addresses_by_code`
 * inside the program; the harness still needs to pass it as an account
 * (Anchor IDL requires the mint Pubkey at the account-validation layer).
 */
export interface SolanaSwapSplRequest {
  sourceTokenCode:    bigint
  sourceReserveCode:  bigint
  /** Source amount in chain-native units (6-dec for USDC/USDT, etc.). */
  sourceAmount:       bigint
  /** SPL mint Pubkey for `sourceTokenCode`. */
  sourceMint:         PublicKey
  targetChainCode:    bigint
  targetTokenCode:    bigint
  targetReserveCode:  bigint
  targetRecipient:    Uint8Array
  targetAmount:       bigint
  targetToleranceBps: number
}

/**
 * Submit a SOL → other-chain SWAP_REQUEST via the Solana outpost's
 * `request_swap_spl` ix. Source-side custody comes from the user's
 * Associated Token Account (ATA) for `sourceMint`; the on-chain ix
 * transfers `sourceAmount` token units into the per-reserve
 * `reserve_vault` PDA.
 *
 * @param connection RPC connection.
 * @param program    Anchor program bound to the deployed `opp_outpost` IDL.
 * @param user       Keypair signing the swap. Must hold an ATA for
 *                   `sourceMint` with at least `sourceAmount` units +
 *                   enough SOL for fees.
 * @param request    Structured SPL swap parameters.
 * @return The transaction signature on confirm.
 */
export async function requestSolanaSwapSpl(
  connection: Connection,
  program:    anchor.Program<anchor.Idl>,
  user:       Keypair,
  request:    SolanaSwapSplRequest
): Promise<string> {
  Assert.ok(request.sourceAmount > 0n,
    "SolanaSwapTool: sourceAmount must be > 0")
  Assert.ok(request.targetRecipient.byteLength > 0,
    "SolanaSwapTool: targetRecipient must be non-empty")
  Assert.ok(request.targetAmount > 0n,
    "SolanaSwapTool: targetAmount must be > 0")
  Assert.ok(
    request.targetToleranceBps >= 0 && request.targetToleranceBps <= 10_000,
    `SolanaSwapTool: targetToleranceBps must be in [0, 10000], got ${request.targetToleranceBps}`
  )

  const programId                  = program.programId
  const [configPda]                = PublicKey.findProgramAddressSync([OUTPOST_CONFIG_SEED], programId)
  const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync([OUTBOUND_MESSAGE_BUFFER_SEED], programId)

  const sourceTokenCodeLE   = toU64LeBuffer(request.sourceTokenCode)
  const sourceReserveCodeLE = toU64LeBuffer(request.sourceReserveCode)
  const [reservePda]      = PublicKey.findProgramAddressSync(
    [RESERVE_SEED, sourceTokenCodeLE, sourceReserveCodeLE], programId
  )
  const [reserveVaultPda] = PublicKey.findProgramAddressSync(
    [RESERVE_VAULT_SEED, sourceTokenCodeLE, sourceReserveCodeLE], programId
  )

  // The user's ATA for `sourceMint` MUST exist before this call — the
  // SwapDeposit funding flow is responsible (e.g. `SplFundingTool`).
  const userAta = getAssociatedTokenAddressSync(request.sourceMint, user.publicKey)

  const tx = await program.methods
    .requestSwapSpl(
      new anchor.BN(request.sourceTokenCode.toString()),
      new anchor.BN(request.sourceReserveCode.toString()),
      new anchor.BN(request.sourceAmount.toString()),
      new anchor.BN(request.targetChainCode.toString()),
      new anchor.BN(request.targetTokenCode.toString()),
      new anchor.BN(request.targetReserveCode.toString()),
      Buffer.from(request.targetRecipient),
      new anchor.BN(request.targetAmount.toString()),
      request.targetToleranceBps
    )
    .accounts({
      user:                  user.publicKey,
      config:                configPda,
      reserve:               reservePda,
      reserveVault:          reserveVaultPda,
      mint:                  request.sourceMint,
      userAta,
      outboundMessageBuffer: outboundMessageBufferPda,
      tokenProgram:          TOKEN_PROGRAM_ID
    })
    .signers([user])
    .transaction()

  const sig = await connection.sendTransaction(tx, [user], { skipPreflight: false })
  await confirmSignature(connection, sig, "SolanaSwapTool request_swap_spl")
  return sig
}
