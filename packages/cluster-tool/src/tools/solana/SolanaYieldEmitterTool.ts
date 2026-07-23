/**
 * SolanaYieldEmitterTool — drive a genuine STAKING_REWARD emission out of the
 * folded `liqsol_core` outpost's real yield pipeline.
 *
 * The flow-yield-distribution test uses this to mirror the ETH side's
 * `MockYieldEmitter.sol`: seed a staker's on-chain yield state via the dev-only
 * `dev_seed_staker_yield` (compiled under `--features development`), then crank
 * `flush_staking_yield` so the program itself packs a real `StakingReward` into
 * the outbound buffer — the exact path a production yield-aware Solana contract
 * exercises. Both instructions are signed by the SOL outpost deployer keypair
 * (== `global_config.admin`, which is also the `cranker`).
 *
 * Once the flush lands the reward, the batch-operator plugin picks it up, packs
 * the next `BATCH_OPERATOR_GROUPS` envelope, and the depot dispatches it as
 * `sysio.dclaim::onreward` — same code path a production STAKING_REWARD would.
 */

import Assert from "node:assert"
import * as anchor from "@coral-xyz/anchor"
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction
} from "@solana/web3.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"

/** Seed for the `OutpostConfig` singleton PDA (mirrors
 *  `wire-solana/programs/liqsol-core/src/states/opp_states.rs`). */
const OUTPOST_CONFIG_SEED = Buffer.from("outpost_config")
/** Seed for the `OutboundMessageBuffer` singleton PDA. */
const OUTBOUND_MESSAGE_BUFFER_SEED = Buffer.from("outbound_message_buffer")
/** Seed for the shared liqsol `global_config` PDA (`has_one = admin`). */
const GLOBAL_CONFIG_SEED = Buffer.from("global_config")
/** Seed for the outpost `GlobalState` singleton PDA. */
const OUTPOST_GLOBAL_STATE_SEED = Buffer.from("outpost_global_state")
/** Seed for the `TokenPurchaseHistory` ring PDA. */
const TOKEN_PURCHASE_HISTORY_SEED = Buffer.from("token_purchase_history")
/** Seed prefix for a staker's `OutpostAccount` PDA (`[b"outpost_account", staker]`). */
const OUTPOST_ACCOUNT_SEED = Buffer.from("outpost_account")

/** Per-staker entry in a yield emission. Mirrors the ETH side's `YieldEntry`
 *  shape for ergonomic symmetry across the two emitter helpers. */
export interface SolanaYieldEntry {
  /** Solana wallet pubkey of the staker. The 32-byte raw bytes become
   *  the depot-side `StakingReward.staker_native_address.address`
   *  field, keyed under `ChainKind.SVM`. */
  staker: PublicKey
  /** WIRE account name to credit. May be `""` for pre-link stakers —
   *  the depot parks the reward by `staker_native_address` until the
   *  authex link sweep moves it (`sysio.dclaim::linkswept`). */
  wireAccount: string
  /** Reward amount in chain-native base units (lamports for SOL). */
  rewardAmount: bigint
  /** Informational share-in-bps; the depot logs but doesn't enforce. */
  shareBps: number
}

/**
 * Emit a genuine STAKING_REWARD for one staker through the program's real yield
 * pipeline: seed the on-chain yield state with the dev instruction
 * `dev_seed_staker_yield` (seeds `GlobalState`→PostLaunch + the
 * `TokenPurchaseHistory` ring + the staker's `OutpostAccount`), then crank
 * `flush_staking_yield` so the program emits the `StakingReward` (WIRE_TOKEN_CODE
 * = 0, ref derived from the warped SOLANA epoch) into the outbound buffer. Two
 * separate signed+confirmed transactions (seed, then flush) — the flush reads
 * the state the seed committed.
 *
 * Each instruction is built via the Anchor `Program` (`.instruction()`) and
 * submitted through a manual `connection.sendTransaction` +
 * {@link confirmSignature} (anchor's `.rpc()` confirm is unreliable in the
 * test-validator env). Only `entry.staker` + `entry.rewardAmount` are used —
 * the program forces the token code and derives the external epoch ref.
 *
 * @param connection Solana RPC connection (typically `solClient.connection`).
 * @param program    Anchor `Program` bound to the `liqsol_core` dev IDL
 *                   (exposes `devSeedStakerYield` + `flushStakingYield`).
 * @param authority  SOL deployer keypair = `global_config.admin`; signs BOTH
 *                   the seed (as `admin`) and the flush (as `cranker`).
 * @param entry      Per-staker triple — only `staker` + `rewardAmount` are used.
 * @return Confirmed signature of the `flush_staking_yield` transaction.
 */
export async function emitSolanaYield(
  connection: Connection,
  program:    anchor.Program<anchor.Idl>,
  authority:  Keypair,
  entry:      SolanaYieldEntry
): Promise<string> {
  Assert.ok(entry.rewardAmount > 0n, "SolanaYieldEmitterTool: rewardAmount must be positive")

  const programId = program.programId
  const [globalConfigPda] = PublicKey.findProgramAddressSync([GLOBAL_CONFIG_SEED], programId)
  const [globalStatePda] = PublicKey.findProgramAddressSync([OUTPOST_GLOBAL_STATE_SEED], programId)
  const [tokenPurchaseHistoryPda] = PublicKey.findProgramAddressSync(
    [TOKEN_PURCHASE_HISTORY_SEED],
    programId
  )
  const [outpostAccountPda] = PublicKey.findProgramAddressSync(
    [OUTPOST_ACCOUNT_SEED, entry.staker.toBytes()],
    programId
  )
  const [configPda] = PublicKey.findProgramAddressSync([OUTPOST_CONFIG_SEED], programId)
  const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync(
    [OUTBOUND_MESSAGE_BUFFER_SEED],
    programId
  )

  // ── 1. Seed the yield state for this staker ──
  const seedIx = await program.methods
    .devSeedStakerYield(entry.staker, new anchor.BN(entry.rewardAmount.toString()))
    .accounts({
      admin:                authority.publicKey,
      globalConfig:         globalConfigPda,
      globalState:          globalStatePda,
      tokenPurchaseHistory: tokenPurchaseHistoryPda,
      outpostAccount:       outpostAccountPda,
      systemProgram:        SystemProgram.programId
    })
    .instruction()

  const seedSig = await connection.sendTransaction(
    new Transaction().add(seedIx),
    [authority],
    { skipPreflight: false }
  )
  await confirmSignature(connection, seedSig, "SolanaYieldEmitterTool dev_seed_staker_yield")

  // ── 2. Crank the REAL flush — the program emits the StakingReward ──
  const flushIx = await program.methods
    .flushStakingYield()
    .accounts({
      cranker:                authority.publicKey,
      globalState:            globalStatePda,
      tokenPurchaseHistory:   tokenPurchaseHistoryPda,
      config:                 configPda,
      outboundMessageBuffer:  outboundMessageBufferPda,
      systemProgram:          SystemProgram.programId
    })
    .remainingAccounts([
      { pubkey: outpostAccountPda, isSigner: false, isWritable: true }
    ])
    .instruction()

  const flushSig = await connection.sendTransaction(
    new Transaction().add(flushIx),
    [authority],
    { skipPreflight: false }
  )
  await confirmSignature(connection, flushSig, "SolanaYieldEmitterTool flush_staking_yield")
  return flushSig
}
