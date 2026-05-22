/**
 * SplFundingTool — test-cluster helpers for creating mock SPL mints
 * and funding user wallets with token balances on the local Solana
 * validator.
 *
 * The Solana side has no equivalent of EIP-2612 permit — every SPL
 * transfer requires the holder's signature at submission time. The
 * harness funds users by:
 *
 *   1. Creating a mock mint with manual `SystemProgram.createAccount`
 *      + `initializeMintInstruction` (avoids `@solana/spl-token`'s
 *      `createMint` which relies on a WebSocket subscription for tx
 *      confirmation — `solana-test-validator` doesn't always serve a
 *      reachable WS endpoint, and the rest of `SOLBootstrap` uses
 *      `getSignatureStatus` polling for confirmation).
 *   2. Creating the user's Associated Token Account on first need via
 *      `createAssociatedTokenAccountInstruction`.
 *   3. Calling `createMintToInstruction` to credit the user's ATA.
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
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction
} from "@solana/web3.js"
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync
} from "@solana/spl-token"

import { log } from "../logger.js"

/** Polling cadence + deadline for transaction confirmation. Matches
 *  `SOLBootstrap`'s pattern so all SPL setup steps confirm the same
 *  way (no WebSocket dependency). */
const POLL_INTERVAL_MS = 500
const POLL_DEADLINE_MS = 60_000

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
  log.info(`[SplFundingTool] createMockSplMint start (decimals=${decimals})`)

  const mintKeypair = Keypair.generate()
  log.info(`[SplFundingTool] generated mint keypair pubkey=${mintKeypair.publicKey.toBase58()}`)
  const rentLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
  log.info(`[SplFundingTool] rent lamports=${rentLamports}`)
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey:       funder.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space:            MINT_SIZE,
      lamports:         rentLamports,
      programId:        TOKEN_PROGRAM_ID
    }),
    createInitializeMint2Instruction(
      mintKeypair.publicKey,
      decimals,
      funder.publicKey,
      null
    )
  )
  log.info(`[SplFundingTool] tx built, calling sendAndPoll`)
  await sendAndPoll(connection, tx, [funder, mintKeypair], "createMockSplMint")
  log.info(`[SplFundingTool] sendAndPoll returned, mint=${mintKeypair.publicKey.toBase58()}`)
  return mintKeypair.publicKey
}

/**
 * Credit `amount` units of `mint` to `recipient`'s Associated Token
 * Account, creating the ATA first if it doesn't yet exist. Returns the
 * ATA's public key for downstream balance assertions.
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

  const ata        = getAssociatedTokenAddressSync(mint, recipient)
  const ataInfo    = await connection.getAccountInfo(ata)
  const tx         = new Transaction()
  if (ataInfo === null) {
    tx.add(createAssociatedTokenAccountInstruction(funder.publicKey, ata, recipient, mint))
  }
  tx.add(createMintToInstruction(mint, ata, funder.publicKey, amount))
  await sendAndPoll(connection, tx, [funder], "mintMockSplToUser")
  return ata
}

/**
 * Sign, send, and poll for confirmation of `tx`. Mirrors
 * `SOLBootstrap`'s submission pattern — no `confirmTransaction`,
 * no WebSocket subscription. Fetches a recent blockhash inline so
 * stale-blockhash drops don't cause the harness's longer-running
 * SPL setup to fail.
 */
async function sendAndPoll(
  connection: Connection,
  tx:         Transaction,
  signers:    Keypair[],
  label:      string
): Promise<string> {
  log.info(`[sendAndPoll/${label}] fetching blockhash`)
  const { blockhash } = await connection.getLatestBlockhash("confirmed")
  log.info(`[sendAndPoll/${label}] got blockhash=${blockhash.slice(0,12)}...`)
  tx.recentBlockhash = blockhash
  tx.feePayer        = signers[0].publicKey
  tx.sign(...signers)
  log.info(`[sendAndPoll/${label}] tx signed, calling sendRawTransaction`)

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false })
  log.info(`[sendAndPoll/${label}] sendRawTransaction returned sig=${sig}`)
  const deadline = Date.now() + POLL_DEADLINE_MS
  let pollCount = 0
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(sig)
    const conf   = status?.value?.confirmationStatus
    if (pollCount % 10 === 0) {
      log.info(`[sendAndPoll/${label}] poll #${pollCount} conf=${conf} err=${JSON.stringify(status?.value?.err)}`)
    }
    pollCount++
    if (conf === "confirmed" || conf === "finalized") return sig
    if (status?.value?.err) {
      throw new Error(`${label} tx failed: ${JSON.stringify(status.value.err)}`)
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`${label} tx ${sig} not confirmed within ${POLL_DEADLINE_MS}ms`)
}
