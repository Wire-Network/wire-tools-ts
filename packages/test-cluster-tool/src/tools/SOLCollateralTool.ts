/**
 * SOLCollateralTool — call the `opp-outpost::deposit` Anchor instruction
 * to escrow SOL collateral on the Solana outpost.
 *
 * Mirrors `ETHCollateralTool.depositETHCollateral`: a thin wrapper that
 * resolves the program's expected PDAs (`config`, `outbound_message_buffer`,
 * `operator_registry`, `vault`) and submits the `deposit` ix signed by
 * the depositor. The harness owns the connection + program; this tool
 * just builds, signs, and confirms the transaction.
 */

import Assert from "node:assert"
import * as anchor from "@coral-xyz/anchor"
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} from "@solana/web3.js"
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"
import { OperatorType } from "@wireio/opp-typescript-models"
import { confirmSignature } from "../sol/confirmSignature.js"

/** PDA seeds — kept in sync with `wire-solana/programs/opp-outpost/src`. */
const OUTPOST_CONFIG_SEED            = Buffer.from("outpost_config")
const OUTBOUND_MESSAGE_BUFFER_SEED   = Buffer.from("outbound_message_buffer")
const OPERATOR_REGISTRY_SEED         = Buffer.from("operator_registry")
const VAULT_SEED                     = Buffer.from("outpost_vault")
/** Per-`token_code` SPL collateral vault seed — matches
 *  `deposit_non_native.rs::COLLATERAL_VAULT_SEED`. */
const COLLATERAL_VAULT_SEED          = Buffer.from("collateral_vault")

/**
 * Deposit `amount` lamports (or LIQSOL base units, when wired) into the
 * outpost vault and queue an `OPERATOR_ACTION(DEPOSIT_REQUEST)` for the
 * next outbound envelope.
 *
 * @param connection    Solana RPC connection (typically `solClient.connection`).
 * @param program       Anchor `Program` bound to the deployed `opp_outpost` IDL.
 * @param depositor     Keypair whose public key becomes the operator's SOL
 *                      identity on the depot (matched via authex link).
 *                      Must hold at least `amount` lamports + rent.
 * @param operatorType  Numeric `OperatorType` (BATCH / UNDERWRITER / PRODUCER).
 * @param tokenCode     8-byte slug_name (`uint64`) of the deposited token
 *                      — `SlugName.from("SOL")` for native SOL,
 *                      `SlugName.from("LIQSOL")` once LIQSOL custody lands.
 *                      Must already be registered on the outpost via
 *                      `set_token_address` (native uses the all-zeroes
 *                      Pubkey marker).
 * @param amount        Lamports to escrow.
 * @return The transaction signature on confirm.
 */
export async function depositSOLCollateral(
  connection:   Connection,
  program:      anchor.Program<anchor.Idl>,
  depositor:    Keypair,
  operatorType: OperatorType,
  tokenCode:    bigint,
  amount:       bigint
): Promise<string> {
  Assert.ok(amount > 0n, "SOLCollateralTool: amount must be positive")

  const programId = program.programId
  const [configPda]                 = PublicKey.findProgramAddressSync([OUTPOST_CONFIG_SEED], programId)
  const [outboundMessageBufferPda]  = PublicKey.findProgramAddressSync([OUTBOUND_MESSAGE_BUFFER_SEED], programId)
  const [operatorRegistryPda]       = PublicKey.findProgramAddressSync([OPERATOR_REGISTRY_SEED], programId)
  const [vaultPda]                  = PublicKey.findProgramAddressSync([VAULT_SEED], programId)

  // `program.methods.deposit(...)` returns a builder; the args are the
  // Anchor IDL's positional argument list for the deposit ix —
  // operator_type (u32), token_code (u64), amount (u64). Both u64s go
  // through `new anchor.BN(...)` so Borsh sees a `toArrayLike`-able
  // value; the u32 operator_type stays a plain number. See
  // deposit.rs::handle_deposit.
  const tx = await program.methods
    .deposit(
      operatorType,
      new anchor.BN(tokenCode.toString()),
      new anchor.BN(amount.toString())
    )
    .accounts({
      depositor:              depositor.publicKey,
      config:                 configPda,
      operatorRegistry:       operatorRegistryPda,
      outboundMessageBuffer:  outboundMessageBufferPda,
      vault:                  vaultPda,
      systemProgram:          SystemProgram.programId
    })
    .signers([depositor])
    .transaction()

  const sig = await connection.sendTransaction(tx, [depositor], {
    skipPreflight: false
  })

  // Anchor's `.rpc()` uses the deprecated `confirmTransaction` path that
  // hangs on test-validator setups where the WS port is occupied —
  // confirmSignature polls `getSignatureStatus` with a bounded deadline.
  await confirmSignature(connection, sig, "SOLCollateralTool deposit")
  return sig
}

/**
 * Deposit `amount` of SPL token `tokenCode` (e.g. USDCSOL, LIQSOL) into
 * the outpost's per-`tokenCode` SPL collateral vault and queue an
 * `OPERATOR_ACTION(DEPOSIT_REQUEST)` with the supplied `reserveCode`.
 *
 * Counterpart to ETH's `depositETHNonNativeCollateral`. Mirrors the
 * native-deposit polling pattern (no `confirmTransaction`/WS dependency).
 *
 * @param connection      Solana RPC connection.
 * @param program         Anchor `Program` bound to the deployed
 *                        `opp_outpost` IDL — must include the new
 *                        `depositNonNative` IX (rebuild the IDL after
 *                        editing `opp-outpost/src/lib.rs`).
 * @param depositor       Keypair whose ATA is debited. Must hold
 *                        `amount` of `mint` and enough lamports for
 *                        the first-time vault rent.
 * @param chainCode       Outpost chain slug_name (asserted ==
 *                        `OutpostConfig.chain_code`).
 * @param tokenCode       SPL token slug_name (`SlugName.from("USDCSOL")`
 *                        etc.). Must be configured via
 *                        `set_token_address` to a non-marker mint.
 * @param reserveCode     Reserve slug_name the collateral nominally
 *                        backs. Plumbed onto the attestation only.
 * @param operatorType    `OperatorType` numeric enum value.
 * @param mint            SPL mint Pubkey for `tokenCode` — used to
 *                        derive the depositor's ATA and sanity-check
 *                        against the configured mint inside the IX.
 * @param amount          SPL base units to escrow.
 * @return The transaction signature on confirm.
 */
export async function depositSOLNonNativeCollateral(
  connection:   Connection,
  program:      anchor.Program<anchor.Idl>,
  depositor:    Keypair,
  chainCode:    bigint,
  tokenCode:    bigint,
  reserveCode:  bigint,
  operatorType: OperatorType,
  mint:         PublicKey,
  amount:       bigint
): Promise<string> {
  Assert.ok(amount > 0n, "SOLCollateralTool: amount must be positive")

  const programId = program.programId
  const [configPda]                = PublicKey.findProgramAddressSync([OUTPOST_CONFIG_SEED], programId)
  const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync([OUTBOUND_MESSAGE_BUFFER_SEED], programId)
  const [operatorRegistryPda]      = PublicKey.findProgramAddressSync([OPERATOR_REGISTRY_SEED], programId)
  const tokenCodeLeBytes = Buffer.alloc(8)
  tokenCodeLeBytes.writeBigUInt64LE(tokenCode)
  const [collateralVaultPda] = PublicKey.findProgramAddressSync(
    [COLLATERAL_VAULT_SEED, tokenCodeLeBytes],
    programId
  )
  const depositorAta = getAssociatedTokenAddressSync(mint, depositor.publicKey)

  const tx = await program.methods
    .depositNonNative(
      new anchor.BN(chainCode.toString()),
      new anchor.BN(tokenCode.toString()),
      new anchor.BN(reserveCode.toString()),
      operatorType,
      new anchor.BN(amount.toString())
    )
    .accounts({
      depositor:              depositor.publicKey,
      config:                 configPda,
      operatorRegistry:       operatorRegistryPda,
      outboundMessageBuffer:  outboundMessageBufferPda,
      mint,
      depositorAta,
      collateralVault:        collateralVaultPda,
      tokenProgram:           TOKEN_PROGRAM_ID,
      systemProgram:          SystemProgram.programId,
      rent:                   SYSVAR_RENT_PUBKEY
    })
    .signers([depositor])
    .transaction()

  const sig = await connection.sendTransaction(tx, [depositor], {
    skipPreflight: false
  })

  await confirmSignature(connection, sig, "SOLCollateralTool depositNonNative")
  return sig
}
