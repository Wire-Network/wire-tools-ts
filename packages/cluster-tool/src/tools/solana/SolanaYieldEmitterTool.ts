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
 */

import Assert from "node:assert"
import * as crypto from "node:crypto"
import * as anchor from "@coral-xyz/anchor"
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js"
import {
  ChainKind,
  type StakingReward,
  StakingReward as StakingRewardMsg
} from "@wireio/opp-typescript-models"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"

/** Seed for the `OutpostConfig` singleton PDA (mirrors
 *  `wire-solana/programs/liqsol-core/src/states/opp_states.rs`). */
const OUTPOST_CONFIG_SEED = Buffer.from("outpost_config")
/** Seed for the `OutboundMessageBuffer` singleton PDA. */
const OUTBOUND_MESSAGE_BUFFER_SEED = Buffer.from("outbound_message_buffer")

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
 * The Anchor IDL declares `attestation_type` as the protobuf-derived
 * `AttestationType` enum. Anchor-TS encodes enum variants as
 * `{ <variantName>: {} }`; the matching variant for STAKING_REWARD is
 * `attestationTypeStakingReward`.
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

  const encoded = encodeStakingReward(
    entry,
    chainCode,
    tokenCode,
    externalEpochRef,
    rewardEpochIndex
  )

  const programId = program.programId
  const [configPda] = PublicKey.findProgramAddressSync([OUTPOST_CONFIG_SEED], programId)
  const [outboundMessageBufferPda] = PublicKey.findProgramAddressSync(
    [OUTBOUND_MESSAGE_BUFFER_SEED],
    programId
  )

  // `add_attestation`'s `AttestationType` arg is declared in the IDL as a
  // unit enum, but the proto-generated Rust enum carries a custom Borsh
  // impl that serializes as `i32` (4-byte LE) — see the wire-opp-solana-models
  // crate (types.rs):
  //   impl borsh::BorshSerialize for AttestationType { ... as i32 ... }
  // anchor.Program would encode it as the IDL's 1-byte variant tag,
  // producing bytes the program's deserializer reads as a corrupted
  // payload (and the OOM the proto-derived enum's `from(i32)` tries to
  // allocate a `Vec` over). So we build the instruction by hand with
  // the correct Borsh shape: 8-byte Anchor discriminator + i32 LE
  // attestation_type + Vec<u8> data (4-byte LE length + bytes).
  //
  // Anchor's instruction discriminator is the first 8 bytes of
  //   sha256("global:add_attestation")
  // — same convention every Anchor-generated client uses.
  const ATTESTATION_TYPE_STAKING_REWARD = 60950 // proto enum value

  const discriminator = crypto
    .createHash("sha256")
    .update("global:add_attestation")
    .digest()
    .subarray(0, 8)

  const dataBuf = Buffer.from(encoded)
  const ixData = Buffer.alloc(8 + 4 + 4 + dataBuf.length)
  let off = 0
  discriminator.copy(ixData, off); off += 8
  ixData.writeInt32LE(ATTESTATION_TYPE_STAKING_REWARD, off); off += 4
  ixData.writeUInt32LE(dataBuf.length, off); off += 4
  dataBuf.copy(ixData, off)

  // `AddAttestation` declares exactly 3 accounts (authority, config,
  // outbound_message_buffer) — the keys below must match that list.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority.publicKey,         isSigner: true,  isWritable: true  },
      { pubkey: configPda,                   isSigner: false, isWritable: false },
      { pubkey: outboundMessageBufferPda,    isSigner: false, isWritable: true  }
    ],
    data: ixData
  })
  const tx = new Transaction().add(ix)

  const sig = await connection.sendTransaction(tx, [authority], {
    skipPreflight: false
  })

  // Poll for confirmation via the shared bounded poller — anchor's
  // .rpc() confirmTransaction is broken in our test-validator env.
  await confirmSignature(connection, sig, "SolanaYieldEmitterTool add_attestation")
  return sig
}
