/**
 * LiqsolPdaSeed — the seed strings every liqsol PDA in this repo is derived
 * from.
 *
 * Its own module because two layers need it: `SolanaLiqsolSurfaceSteps`
 * (orchestration) creates these accounts during the bootstrap, and
 * `SolanaLiqSyndicationTool` (tools) transacts against them afterwards. One
 * declaration, imported by both — never a second copy on either side.
 */

import Assert from "node:assert"

import type { PublicKey } from "@solana/web3.js"

import { SolanaOutpostProgramTool } from "./SolanaOutpostProgramTool.js"

/**
 * PDA seeds of the liqsol surface, mirroring
 * `wire-solana/programs/liqsol-core/src` (plus `liqsol-token` /
 * `transfer-hook` where noted). Never re-spell a seed literal at a call site.
 *
 * THE one declaration: the bootstrap phase that CREATES these accounts and the
 * syndication tool that later transacts against them derive from the same
 * strings, so a seed rename is one edit.
 */
export namespace LiqsolPdaSeed {
  /** `liqsol-core` — the wire `GlobalState` (launch state, pool totals, liq sequence + watermark). */
  export const GlobalState = "outpost_global_state"
  /** `liqsol-core` — the syndicated-pool authority that owns the pool ATA. */
  export const PoolAuthority = "liqsol_pool"
  /**
   * `liqsol-core` — the pretoken purchase-history ring (`+ pool_authority`).
   * Its `starting_epoch` doubles as the program's "initialized" sentinel, which
   * is why the bootstrap reads it back.
   */
  export const PretokenPurchaseHistory = "pretoken_purchase_history"
  /** `liqsol-core` — the distribution state (yield index + bucket accounting). */
  export const DistributionState = "distribution_state"
  /** `liqsol-core` — the distribution-bucket authority. */
  export const BucketAuthority = "liqsol_bucket"
  /** `liqsol-core` — per-token-account distribution record (`user_record` + the ATA). */
  export const UserRecord = "user_record"
  /** `liqsol-core` — per-user pre-launch syndication position (`outpost_account` + the user). */
  export const OutpostAccount = "outpost_account"
  /** `liqsol-core` — the stake-controller reserve pool (receives the donated lamports). */
  export const ReservePool = "reserve_pool"
  /** `liqsol-core` — the CPI signer that authorizes liqSOL mints. */
  export const DepositAuthority = "deposit_authority"
  /** `liqsol-core` — the stake-controller vault. */
  export const Vault = "vault"
  /** `liqsol-core` — the stake-controller state. */
  export const StakeControllerState = "stake_controller"
  /** `liqsol-core` — the payout state (fee accounting). */
  export const PayoutState = "payout_state"
  /** `liqsol-core` — the pay-rate history ring the deposit fee derives from. */
  export const PayRateHistory = "pay_rate_history"
  /** `liqsol-token` — the liqSOL Token-2022 mint. */
  export const LiqsolMint = "liqsol_mint"
  /** `liqsol-token` — the liqSOL mint authority. */
  export const LiqsolMintAuthority = "mint_authority"
  /** `transfer-hook` — the liqSOL mint's `ExtraAccountMetaList` (`+ mint`). */
  export const ExtraAccountMetaList = "extra-account-metas"
  /**
   * `liqsol-core` — a stored `DESYNDICATE_LIQ` payout (`PendingPayout`,
   * `+ request_id` as 8 little-endian bytes): `states/pending_payout.rs`
   * `PENDING_PAYOUT_SEED`, and the wire-sysio relay's
   * `PENDING_DESYNDICATION_SEED`, which derives the same account for the
   * dispatch manifest. A rename here is a rename in both.
   */
  export const PendingDesyndication = "pending_desyndication"
}

/** Byte width of the `request_id` seed leg (`u64::to_le_bytes`). */
export const PendingPayoutRequestIdBytes = 8

/**
 * The `PendingPayout` PDA holding the stored `DESYNDICATE_LIQ` of `requestId`
 * — `["pending_desyndication", request_id.to_le_bytes()]` under
 * `liqsol_core`, the derivation of `PendingPayout::find_address` and of the
 * relay's `derive_pending_desyndication_pda`. A pure value helper.
 *
 * @param programId - The deployed `liqsol_core` program id.
 * @param requestId - The depot's `DesyndicateLIQ.request_id` (a `u64`, never 0).
 * @returns The pending-payout account address.
 * @throws If `requestId` is not a positive `u64` — 0 means "no id" and keys no
 *   PDA on chain.
 */
export function pendingPayoutAddress(
  programId: PublicKey,
  requestId: bigint
): PublicKey {
  Assert.ok(
    requestId > 0n && requestId < 1n << 64n,
    `pendingPayoutAddress: request id ${requestId} is not a positive u64`
  )
  const requestIdSeed = Buffer.alloc(PendingPayoutRequestIdBytes)
  requestIdSeed.writeBigUInt64LE(requestId)
  return SolanaOutpostProgramTool.derivePda(
    programId,
    Buffer.from(LiqsolPdaSeed.PendingDesyndication),
    requestIdSeed
  )
}
