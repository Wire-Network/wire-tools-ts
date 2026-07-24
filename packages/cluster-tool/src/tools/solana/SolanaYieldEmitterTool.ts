/**
 * SolanaYieldEmitterTool — drive a genuine STAKING_REWARD emission out of the
 * folded `liqsol_core` outpost's real yield pipeline, ONE transaction per
 * helper so each orchestration Step performs exactly one write:
 *
 * - {@link devSeedStakerYield} — seed a staker's on-chain yield state via the
 *   dev-only `dev_seed_staker_yield` (compiled under `--features development`).
 * - {@link flushStakingYield} — crank `flush_staking_yield` so the program
 *   itself packs a real `StakingReward` into the outbound buffer — the exact
 *   path a production yield-aware Solana contract exercises.
 *
 * The flow-yield-distribution test composes the two as consecutive Steps to
 * mirror the ETH side's `MockYieldEmitter.sol`. Both instructions are signed
 * by the SOL outpost deployer keypair (== `global_config.admin`, which is also
 * the flush `cranker`). Once the flush lands the reward, the batch-operator
 * plugin picks it up, packs the next `BATCH_OPERATOR_GROUPS` envelope, and the
 * depot dispatches it as `sysio.dclaim::onreward` — same code path a
 * production STAKING_REWARD would.
 *
 * Each instruction is built via the Anchor `Program` (`.instruction()`) and
 * submitted through a manual `connection.sendTransaction` +
 * {@link confirmSignature} (anchor's `.rpc()` confirm is unreliable in the
 * test-validator env).
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
import { SolanaOutpostBootstrapper } from "../../orchestration/solana/SolanaOutpostBootstrapper.js"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"

/**
 * Seed one staker's on-chain yield state via the dev-only
 * `liqsol_core::dev_seed_staker_yield` instruction (seeds
 * `GlobalState`→PostLaunch + the `TokenPurchaseHistory` ring + the staker's
 * `OutpostAccount`). Gated on the Solana clock having reached epoch 3
 * (`MIN_SEED_EPOCH` — the credited epoch is `Clock.epoch - 2` and must be ≥
 * the launch epoch), which the epoch-warped validator satisfies. ONE signed +
 * poll-confirmed transaction.
 *
 * @param connection - Solana RPC connection (typically `solClient.connection`).
 * @param program - Anchor `Program` bound to the `liqsol_core` dev IDL — a
 *   plain `anchor build` omits `dev_seed_staker_yield` from the `.so` and IDL.
 * @param authority - SOL deployer keypair == `global_config.admin`.
 * @param staker - The staker whose `OutpostAccount` yield state is seeded.
 * @param rewardAmount - WIRE-yield amount to seed (the flush emits it verbatim).
 * @return Confirmed transaction signature.
 */
export async function devSeedStakerYield(
  connection: Connection,
  program: anchor.Program<anchor.Idl>,
  authority: Keypair,
  staker: PublicKey,
  rewardAmount: bigint
): Promise<string> {
  Assert.ok(rewardAmount > 0n, "SolanaYieldEmitterTool: rewardAmount must be positive")

  const PdaSeed = SolanaOutpostBootstrapper.PdaSeed,
    programId = program.programId,
    [globalConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.GlobalConfig)],
      programId
    ),
    [globalStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutpostGlobalState)],
      programId
    ),
    [tokenPurchaseHistoryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.TokenPurchaseHistory)],
      programId
    ),
    [outpostAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutpostAccount), staker.toBytes()],
      programId
    )

  const seedInstruction = await program.methods
    .devSeedStakerYield(staker, new anchor.BN(rewardAmount.toString()))
    .accounts({
      admin: authority.publicKey,
      globalConfig: globalConfigPda,
      globalState: globalStatePda,
      tokenPurchaseHistory: tokenPurchaseHistoryPda,
      outpostAccount: outpostAccountPda,
      systemProgram: SystemProgram.programId
    })
    .instruction()

  const signature = await connection.sendTransaction(
    new Transaction().add(seedInstruction),
    [authority],
    { skipPreflight: false }
  )
  await confirmSignature(connection, signature, "SolanaYieldEmitterTool dev_seed_staker_yield")
  return signature
}

/**
 * Crank `liqsol_core::flush_staking_yield` for one seeded staker — the program
 * packs a real `StakingReward` (WIRE token code, external epoch ref derived
 * from the Solana epoch) into the outbound message buffer. ONE signed +
 * poll-confirmed transaction; the staker's `OutpostAccount` rides
 * `remaining_accounts` (the flush walks whatever accounts the cranker passes).
 *
 * @param connection - Solana RPC connection (typically `solClient.connection`).
 * @param program - Anchor `Program` bound to the `liqsol_core` IDL.
 * @param authority - SOL deployer keypair; signs as the permissionless `cranker`.
 * @param staker - The seeded staker whose `OutpostAccount` is flushed.
 * @return Confirmed transaction signature.
 */
export async function flushStakingYield(
  connection: Connection,
  program: anchor.Program<anchor.Idl>,
  authority: Keypair,
  staker: PublicKey
): Promise<string> {
  const PdaSeed = SolanaOutpostBootstrapper.PdaSeed,
    programId = program.programId,
    [globalStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutpostGlobalState)],
      programId
    ),
    [tokenPurchaseHistoryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.TokenPurchaseHistory)],
      programId
    ),
    [outpostAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutpostAccount), staker.toBytes()],
      programId
    ),
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutpostConfig)],
      programId
    ),
    [outboundMessageBufferPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(PdaSeed.OutboundMessageBuffer)],
      programId
    )

  const flushInstruction = await program.methods
    .flushStakingYield()
    .accounts({
      cranker: authority.publicKey,
      globalState: globalStatePda,
      tokenPurchaseHistory: tokenPurchaseHistoryPda,
      config: configPda,
      outboundMessageBuffer: outboundMessageBufferPda,
      systemProgram: SystemProgram.programId
    })
    .remainingAccounts([
      { pubkey: outpostAccountPda, isSigner: false, isWritable: true }
    ])
    .instruction()

  const signature = await connection.sendTransaction(
    new Transaction().add(flushInstruction),
    [authority],
    { skipPreflight: false }
  )
  await confirmSignature(connection, signature, "SolanaYieldEmitterTool flush_staking_yield")
  return signature
}
