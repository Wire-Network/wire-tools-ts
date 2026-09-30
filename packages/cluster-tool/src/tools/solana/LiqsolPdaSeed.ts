/**
 * LiqsolPdaSeed — the seed strings every liqsol PDA in this repo is derived
 * from.
 *
 * Its own module because two layers need it: `SolanaLiqsolSurfaceSteps`
 * (orchestration) creates these accounts during the bootstrap, and
 * `SolanaLiqSyndicationTool` (tools) transacts against them afterwards. One
 * declaration, imported by both — never a second copy on either side.
 */

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
}
