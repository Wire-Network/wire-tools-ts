import type { TokenAmount } from "@wireio/opp-typescript-models"

/**
 * Harness-local (chain, token) amount tuple. The previous proto-emitted
 * `ChainTokenAmount` was removed in the v6 data-model refactor — `Token.code`
 * is globally unique now, so the proto carries `TokenAmount` (just
 * `token_code` + `amount`) without a redundant chain tag. We still need the
 * chain dimension at the harness layer (per-underwriter collateral fans out
 * across `{ETH, SOL, WIRE}`), so this local shape pairs each `TokenAmount`
 * with its `chain_code` (slug_name / uint64).
 *
 * Persisted through `cluster-config.json` — `amount.amount` is `bigint`,
 * which `JSON.stringify` cannot serialise natively. `ClusterConfigProvider`'s
 * save/load path projects the field through the proto `TokenAmount`'s JSON
 * helpers so the int64 round-trips losslessly as a string.
 */
export interface ChainTokenAmount {
  /** SlugName / uint64 chain identifier (e.g. `SlugName.from("ETHEREUM")`). */
  chain_code: number
  /** Token amount carrying its own slug_name + int64 amount. */
  amount: TokenAmount
}
