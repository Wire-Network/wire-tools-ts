import { ChainKind, TokenKind } from "@wireio/opp-typescript-models"
import type { UnderwriterCollateralEntry } from "@wireio/debugging-shared"

/**
 * Default per-(chain, token) deposit amount when neither
 * `--underwriter-collateral-json-file` nor a programmatic override is
 * provided. The spec at "Underwriter Collateral Config for
 * `test-cluster-tool`" reads "deposit `1000` tokens of each
 * integrated outposts default token (and WIRE)", interpreted here as
 * `1000` base units (lamports / wei / WIRE-smallest-unit). Tests that
 * need realistic magnitudes pass `--underwriter-collateral-json-file`
 * with explicit per-leg amounts.
 *
 * Changing this constant rescales the default deposit across every
 * underwriter on every integrated chain; consumers that want a
 * different value should set the JSON config file rather than tweak
 * this default.
 */
export const DefaultUnderwriterCollateralAmount = "1000"

/**
 * Default chain/token pairs deposited to every underwriter when no
 * `--underwriter-collateral-json-file` is supplied. One entry per
 * integrated outpost's default token, plus the WIRE/WIRE pair.
 *
 * Tracks the integrated-outpost set; if a new outpost is added (Sui,
 * etc.), add the corresponding `(ChainKind, TokenKind)` pair here so
 * the default deposits cover it without requiring every caller to
 * specify a config file.
 */
export const DefaultUnderwriterCollateralPairs: ReadonlyArray<{
  chain: ChainKind
  tokenKind: TokenKind
}> = [
  { chain: ChainKind.WIRE, tokenKind: TokenKind.WIRE },
  { chain: ChainKind.ETHEREUM, tokenKind: TokenKind.ETH },
  { chain: ChainKind.SOLANA, tokenKind: TokenKind.SOL }
]

/**
 * Build the default underwriter-collateral set: one entry per
 * `DefaultUnderwriterCollateralPairs` entry, each amounting to
 * `DefaultUnderwriterCollateralAmount` base units.
 *
 * @returns A fresh array (the caller may mutate without aliasing the
 *   defaults). Returns the per-underwriter list shape — fan-out to all
 *   underwriters happens in `loadUnderwriterCollateral`.
 */
export function buildDefaultUnderwriterCollateral(): UnderwriterCollateralEntry[] {
  return DefaultUnderwriterCollateralPairs.map(({ chain, tokenKind }) => ({
    chain,
    chainId: 0,
    tokenKind,
    amount: DefaultUnderwriterCollateralAmount
  }))
}
