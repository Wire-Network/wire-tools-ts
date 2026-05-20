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
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import { OperatorType } from "@wireio/opp-typescript-models"

/** PDA seeds — kept in sync with `wire-solana/programs/opp-outpost/src`. */
const OUTPOST_CONFIG_SEED            = Buffer.from("outpost_config")
const OUTBOUND_MESSAGE_BUFFER_SEED   = Buffer.from("outbound_message_buffer")
const OPERATOR_REGISTRY_SEED         = Buffer.from("operator_registry")
const VAULT_SEED                     = Buffer.from("outpost_vault")

/** Number of ms to poll `getSignatureStatus` before timing out. */
const SOL_CONFIRM_TIMEOUT_MS = 60_000
const SOL_CONFIRM_POLL_MS    = 500

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
  // hangs on test-validator setups where the WS port is occupied; the
  // pattern here matches SOLBootstrap.initializePDAs — poll
  // `getSignatureStatus` with a deadline.
  const deadline = Date.now() + SOL_CONFIRM_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(sig)
    const conf   = status?.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") return sig
    if (status?.value?.err) {
      throw new Error(
        `SOLCollateralTool: deposit tx failed: ${JSON.stringify(status.value.err)}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, SOL_CONFIRM_POLL_MS))
  }
  throw new Error(`SOLCollateralTool: deposit tx ${sig} not confirmed within ${SOL_CONFIRM_TIMEOUT_MS}ms`)
}
