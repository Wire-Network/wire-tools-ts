/**
 * SplFundingTool — test-cluster helpers for creating mock SPL mints
 * and funding user wallets with token balances on the local Solana
 * validator.
 *
 * The Solana side has no equivalent of EIP-2612 permit — every SPL
 * transfer requires the holder's signature at submission time. The
 * harness funds users by:
 *
 *   1. Creating a mock mint with `createMint` (mint authority held by
 *      the cluster funding keypair).
 *   2. Creating the user's Associated Token Account on first need.
 *   3. Calling `mintTo` to credit the user's ATA.
 *
 * **Recipient ATAs for swap *destinations* are NOT pre-created.**
 * The on-chain `handle_swap_remit` SPL branch creates the recipient
 * ATA on demand using the Reserve PDA as rent payer (per
 * `wire-solana/programs/opp-outpost/src/instructions/epoch_in.rs`).
 * This matches the user-facing UX of standard SPL DEXes — the user
 * never has to "claim" or pre-provision an ATA.
 *
 * @see wire-ethereum/contracts/test/outpost/MockUsdc.sol — ETH counterpart.
 */

import Assert from "node:assert"
import { Connection, Keypair, PublicKey } from "@solana/web3.js"
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo
} from "@solana/spl-token"

/**
 * Create a fresh SPL mint with `mintAuthority = funder.publicKey` and
 * no freeze authority. Used by `SOLBootstrap` to provision mock USDC,
 * USDT, etc.
 *
 * @param connection  RPC connection to the test validator.
 * @param funder      Keypair paying rent + holding mint authority.
 *                     Typically the cluster funding keypair.
 * @param decimals    Mint decimal scale. 6 for USDC/USDT, 9 for SOL
 *                     parity, etc.
 * @return The new mint's public key.
 */
export async function createMockSplMint(
  connection: Connection,
  funder:     Keypair,
  decimals:   number
): Promise<PublicKey> {
  Assert.ok(decimals >= 0 && decimals <= 18,
    `SplFundingTool: decimals must be in [0, 18], got ${decimals}`)

  return await createMint(
    connection,
    funder,
    funder.publicKey,
    null,
    decimals
  )
}

/**
 * Credit `amount` units of `mint` to `recipient`'s Associated Token
 * Account, creating the ATA first if it doesn't yet exist. Returns the
 * ATA's public key for downstream balance assertions.
 *
 * Uses `getOrCreateAssociatedTokenAccount` rather than a bare `mintTo`
 * so the helper is safe to call repeatedly during test setup — no
 * "ATA already exists" errors.
 *
 * @param connection     RPC connection.
 * @param funder         Mint-authority keypair + ATA rent payer.
 * @param mint           The SPL mint pubkey (returned by
 *                        `createMockSplMint`).
 * @param recipient      Recipient pubkey.
 * @param amount         Token units to mint (chain-native base units —
 *                        e.g. `1_000_000n` = 1 USDC at 6 decimals).
 * @return The recipient's ATA pubkey.
 */
export async function mintMockSplToUser(
  connection: Connection,
  funder:     Keypair,
  mint:       PublicKey,
  recipient:  PublicKey,
  amount:     bigint
): Promise<PublicKey> {
  Assert.ok(amount > 0n,
    "SplFundingTool: mint amount must be > 0")

  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    funder,
    mint,
    recipient
  )
  await mintTo(
    connection,
    funder,
    mint,
    ata.address,
    funder.publicKey,
    amount
  )
  return ata.address
}
