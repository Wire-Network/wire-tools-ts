import type { Commitment } from "@solana/web3.js"

/**
 * Solana transaction confirmation levels, mirroring web3.js's
 * `TransactionConfirmationStatus` string-literal union.
 *
 * web3.js ships only literal types (no runtime enum), so every branch on a
 * `getSignatureStatus(...).value.confirmationStatus` reading was comparing
 * raw `"confirmed"` / `"finalized"` strings. Branch against these members
 * instead — renames propagate through the compiler, raw strings do not.
 */
export enum SolanaConfirmationStatus {
  Processed = "processed",
  Confirmed = "confirmed",
  Finalized = "finalized"
}

/**
 * Default commitment level for every harness-created Solana `Connection`
 * (and anchor provider). Kept in lock-step with
 * {@link SolanaConfirmationStatus.Confirmed} — asserted by unit test.
 *
 * Raising this to `finalized` slows every harness RPC round-trip on the
 * test validator; lowering it to `processed` lets polls observe state that
 * can still be rolled back.
 */
export const DefaultSolanaCommitment: Commitment = "confirmed"
