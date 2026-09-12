/**
 * SolanaYieldEmitterTool — drive synthetic STAKING_REWARD attestations
 * into the Solana outpost's `OutboundMessageBuffer` via the existing
 * `opp_outpost::add_attestation` CPI target.
 *
 * The flow-yield-distribution test uses this to mirror the ETH side's
 * `MockYieldEmitter.sol` without standing up a separate Anchor program:
 * `add_attestation` is the exact CPI surface a real yield-aware Solana
 * contract would invoke. The helper signs each call with the SOL
 * outpost deployer keypair (== `OutpostConfig.authority` set during
 * Phase 10b bootstrap) and ferries the encoded proto bytes through
 * the same envelope path the batch operator polls.
 *
 * Once `add_attestation` lands the entry, the batch-operator plugin
 * picks it up, packs the next `BATCH_OPERATOR_GROUPS` envelope, and
 * the depot dispatches it as `sysio.dclaim::onreward` — same code
 * path a production STAKING_REWARD would exercise.
 *
 * The instruction itself is assembled by
 * {@link SolanaAddAttestationTool} — the ONE home of the hand-built
 * `add_attestation` ix (the i32-LE attestation-type encoding the
 * proto-derived Rust enum's custom Borsh impl requires) and of the
 * instruction's four-account list.
 */

import Assert from "node:assert"
import type { Connection, Keypair, PublicKey } from "@solana/web3.js"
import type * as anchor from "@coral-xyz/anchor"
import {
  AttestationType,
  ChainKind,
  type StakingReward,
  StakingReward as StakingRewardMsg
} from "@wireio/opp-typescript-models"
import { SolanaAddAttestationTool } from "./SolanaAddAttestationTool.js"

/** Confirmation label for the STAKING_REWARD `add_attestation` submission. */
const StakingRewardConfirmLabel = "SolanaYieldEmitterTool add_attestation"

/** Per-staker entry in an `emitYieldBatch` invocation. Mirrors the ETH
 *  side's `YieldEntry` shape for ergonomic symmetry across the two
 *  emitter helpers. */
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
 * Build a single STAKING_REWARD attestation's encoded proto bytes.
 * Factored out so the test can inspect the payload (e.g. assert the
 * encoded bytes round-trip through `StakingRewardMsg.fromBinary`).
 *
 * @param entry            Per-staker triple.
 * @param chainCode        SlugName-packed `uint64` of the Solana outpost
 *                         (e.g. `SlugName.from("SOLANA")`). Stamped onto
 *                         `chain_code` and `reward_amount.token_code`'s
 *                         containing chain frame.
 * @param tokenCode        SlugName-packed `uint64` of the reward token
 *                         (e.g. `SlugName.from("SOL")`).
 * @param externalEpochRef Monotonic-per-staker reference. The depot's
 *                         `sysio.dclaim::onreward` dedupes against this.
 * @param rewardEpochIndex WIRE epoch index — informational.
 */
export function encodeStakingReward(
  entry:            SolanaYieldEntry,
  chainCode:        bigint,
  tokenCode:        bigint,
  externalEpochRef: bigint,
  rewardEpochIndex: number
): Uint8Array {
  const reward: StakingReward = {
    chainCode,
    stakerWireAccount: { name: entry.wireAccount },
    shareBps: entry.shareBps,
    rewardEpochIndex,
    externalEpochRef,
    rewardAmount: {
      tokenCode,
      amount: entry.rewardAmount
    },
    stakerNativeAddress: {
      kind: ChainKind.SVM,
      address: entry.staker.toBytes()
    }
  }
  return StakingRewardMsg.toBinary(reward)
}

/**
 * Push a single STAKING_REWARD attestation through
 * `opp_outpost::add_attestation`. Multiple entries are submitted one
 * call at a time so the depot's per-staker monotonic check sees
 * distinct `external_epoch_ref` values when needed; callers that need
 * a single-tx batch should iterate this helper inside their own
 * `Promise.all` or pass distinct refs per entry.
 *
 * @param connection         Solana RPC connection (typically `solClient.connection`).
 * @param program            Anchor `Program` bound to `opp_outpost`.
 * @param authority          Deployer keypair = `OutpostConfig.authority`.
 * @param entry              Per-staker triple to emit.
 * @param chainCode          See {@link encodeStakingReward}.
 * @param tokenCode          See {@link encodeStakingReward}.
 * @param externalEpochRef   See {@link encodeStakingReward}.
 * @param rewardEpochIndex   See {@link encodeStakingReward}.
 * @return Confirmed transaction signature.
 */
export async function emitSolanaYield(
  connection:       Connection,
  program:          anchor.Program<anchor.Idl>,
  authority:        Keypair,
  entry:            SolanaYieldEntry,
  chainCode:        bigint,
  tokenCode:        bigint,
  externalEpochRef: bigint,
  rewardEpochIndex: number
): Promise<string> {
  Assert.ok(entry.rewardAmount > 0n, "SolanaYieldEmitterTool: rewardAmount must be positive")
  Assert.ok(externalEpochRef > 0n, "SolanaYieldEmitterTool: externalEpochRef must be positive")

  return SolanaAddAttestationTool.addAttestation(
    connection,
    program.programId,
    authority,
    AttestationType.STAKING_REWARD,
    encodeStakingReward(
      entry,
      chainCode,
      tokenCode,
      externalEpochRef,
      rewardEpochIndex
    ),
    StakingRewardConfirmLabel
  )
}
