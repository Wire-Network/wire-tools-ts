/**
 * SolanaSyndicationTool — drive synthetic liq-syndication attestations into the
 * Solana outpost's `OutboundMessageBuffer` via `liqsol_core::add_attestation`,
 * plus the encoders for the three `simple_swap` attestation messages.
 *
 * The harness deploys only `liqsol_core` — no `liqsol-token`, no Token-2022
 * transfer hook, no distribution state — so a REAL `synd` / `report_liq_yield`
 * cannot execute under a flow cluster. `add_attestation` is the exact enqueue
 * surface those instructions use once the liqsol surface is present, so a
 * synthetic enqueue exercises the identical downstream path: batch-operator
 * ferry → OPP envelope → depot `sysio.msgch` dispatch (which today DROPS these
 * types via its unknown-type default — proving the depot tolerates them is the
 * point of `flow-liq-syndication`).
 *
 * Directions, per the protocol:
 * - `SYNDICATE_LIQ` / `LIQ_YIELD` are outpost → depot (emitted here).
 * - `DESYNDICATE_LIQ` is depot → outpost; only its encoder lives here (the
 *   outpost never emits one), for tests and for decoding-side symmetry.
 *
 * `sequence` is ONE per-outpost strictly-increasing counter SHARED by
 * `SyndicateLiq` and `LiqYield` — callers must not reuse a value across the
 * two. Amounts are base units of the chain's liq token (liqSOL: 9 decimals,
 * 1:1 with the depot frame).
 */

import Assert from "node:assert"
import type { Connection, Keypair, PublicKey } from "@solana/web3.js"
import type * as anchor from "@coral-xyz/anchor"
import {
  AttestationType,
  ChainKind,
  type ChainAddress,
  type DesyndicateLiq,
  DesyndicateLiq as DesyndicateLiqMsg,
  type LiqYield,
  LiqYield as LiqYieldMsg,
  type SyndicateLiq,
  SyndicateLiq as SyndicateLiqMsg
} from "@wireio/opp-typescript-models"
import { SolanaAddAttestationTool } from "./SolanaAddAttestationTool.js"

/** Confirmation label for the SYNDICATE_LIQ `add_attestation` submission. */
const SyndicateLiqConfirmLabel = "SolanaSyndicationTool add_attestation SYNDICATE_LIQ"

/** Confirmation label for the LIQ_YIELD `add_attestation` submission. */
const LiqYieldConfirmLabel = "SolanaSyndicationTool add_attestation LIQ_YIELD"

/**
 * The Solana-native `ChainAddress` for a user pubkey — a `ChainKind.SVM` frame
 * over the 32 raw Ed25519 bytes, the spelling the depot keys syndication
 * identities by until the user AuthEx-links a WIRE account.
 *
 * @param user - The user's Solana wallet pubkey.
 * @returns The generated `ChainAddress` message value.
 */
function solanaChainAddress(user: PublicKey): ChainAddress {
  return { kind: ChainKind.SVM, address: user.toBytes() }
}

/**
 * Encode a `SyndicateLiq` attestation (outpost → depot: the user syndicated
 * `amount` liq tokens, which become outpost property on enqueue).
 *
 * @param chainCode - SlugName-packed `uint64` of the emitting outpost's chain
 *   (e.g. `SlugName.from("SOLANA")`).
 * @param user - The syndicating user's Solana wallet pubkey.
 * @param amount - liq tokens syndicated, base units (must be positive).
 * @param sequence - The outpost's next value on the shared liq sequence.
 * @returns The proto-encoded attestation bytes.
 */
export function encodeSyndicateLiq(
  chainCode: bigint,
  user:      PublicKey,
  amount:    bigint,
  sequence:  bigint
): Uint8Array {
  const syndicate: SyndicateLiq = {
    chainCode,
    user: solanaChainAddress(user),
    amount,
    sequence
  }
  return SyndicateLiqMsg.toBinary(syndicate)
}

/**
 * Encode a `LiqYield` attestation (outpost → depot: the GLOBAL yield the
 * outpost claimed for its syndicated liq pool since the previous report — no
 * per-user address, the depot splits it across its own ledger).
 *
 * @param chainCode - SlugName-packed `uint64` of the emitting outpost's chain.
 * @param amount - liq tokens claimed as yield, base units (must be positive).
 * @param sequence - The outpost's next value on the shared liq sequence.
 * @param epoch - The outpost chain's epoch at which the report was taken
 *   (informational on the depot side).
 * @returns The proto-encoded attestation bytes.
 */
export function encodeLiqYield(
  chainCode: bigint,
  amount:    bigint,
  sequence:  bigint,
  epoch:     bigint
): Uint8Array {
  const liqYield: LiqYield = { chainCode, amount, sequence, epoch }
  return LiqYieldMsg.toBinary(liqYield)
}

/**
 * Encode a `DesyndicateLiq` attestation (depot → outpost: release `amount` liq
 * tokens from the syndicated pool to `user`, paid inline at dispatch).
 *
 * @param chainCode - SlugName-packed `uint64` of the DESTINATION outpost's chain.
 * @param user - The recipient's Solana wallet pubkey.
 * @param amount - liq tokens to release, base units (must be positive).
 * @param requestId - The depot-side request id, for correlation in outpost logs.
 * @returns The proto-encoded attestation bytes.
 */
export function encodeDesyndicateLiq(
  chainCode: bigint,
  user:      PublicKey,
  amount:    bigint,
  requestId: bigint
): Uint8Array {
  const desyndicate: DesyndicateLiq = {
    chainCode,
    user: solanaChainAddress(user),
    amount,
    requestId
  }
  return DesyndicateLiqMsg.toBinary(desyndicate)
}

/**
 * Push a single SYNDICATE_LIQ attestation through
 * `liqsol_core::add_attestation`, signed by the outpost deployer keypair.
 *
 * @param connection - Solana RPC connection (typically `ctx.solana.connection`).
 * @param program - Anchor `Program` bound to `liqsol_core`.
 * @param authority - Deployer keypair == `OutpostConfig.authority` / liqsol `admin`.
 * @param chainCode - See {@link encodeSyndicateLiq}.
 * @param user - See {@link encodeSyndicateLiq}.
 * @param amount - See {@link encodeSyndicateLiq}.
 * @param sequence - See {@link encodeSyndicateLiq}.
 * @returns The confirmed transaction signature.
 */
export async function emitSolanaSyndicateLiq(
  connection: Connection,
  program:    anchor.Program<anchor.Idl>,
  authority:  Keypair,
  chainCode:  bigint,
  user:       PublicKey,
  amount:     bigint,
  sequence:   bigint
): Promise<string> {
  Assert.ok(amount > 0n, "SolanaSyndicationTool: amount must be positive")
  Assert.ok(sequence > 0n, "SolanaSyndicationTool: sequence must be positive")

  return SolanaAddAttestationTool.addAttestation(
    connection,
    program.programId,
    authority,
    AttestationType.SYNDICATE_LIQ,
    encodeSyndicateLiq(chainCode, user, amount, sequence),
    SyndicateLiqConfirmLabel
  )
}

/**
 * Push a single LIQ_YIELD attestation through
 * `liqsol_core::add_attestation`, signed by the outpost deployer keypair.
 *
 * @param connection - Solana RPC connection (typically `ctx.solana.connection`).
 * @param program - Anchor `Program` bound to `liqsol_core`.
 * @param authority - Deployer keypair == `OutpostConfig.authority` / liqsol `admin`.
 * @param chainCode - See {@link encodeLiqYield}.
 * @param amount - See {@link encodeLiqYield}.
 * @param sequence - See {@link encodeLiqYield}.
 * @param epoch - See {@link encodeLiqYield}.
 * @returns The confirmed transaction signature.
 */
export async function emitSolanaLiqYield(
  connection: Connection,
  program:    anchor.Program<anchor.Idl>,
  authority:  Keypair,
  chainCode:  bigint,
  amount:     bigint,
  sequence:   bigint,
  epoch:      bigint
): Promise<string> {
  Assert.ok(amount > 0n, "SolanaSyndicationTool: amount must be positive")
  Assert.ok(sequence > 0n, "SolanaSyndicationTool: sequence must be positive")

  return SolanaAddAttestationTool.addAttestation(
    connection,
    program.programId,
    authority,
    AttestationType.LIQ_YIELD,
    encodeLiqYield(chainCode, amount, sequence, epoch),
    LiqYieldConfirmLabel
  )
}
