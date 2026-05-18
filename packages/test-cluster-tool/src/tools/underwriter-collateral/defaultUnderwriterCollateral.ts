import {
  ChainId,
  ChainKind,
  ChainTokenAmount,
  TokenAmount,
  TokenKind
} from "@wireio/opp-typescript-models"

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
 * Encoded as a `bigint` to match the `TokenAmount.amount` proto field
 * (`@protobuf-ts/runtime` decodes `int64` as `bigint`). Changing this
 * constant rescales the default deposit across every underwriter on
 * every integrated chain; consumers that want a different value
 * should set the JSON config file rather than tweak this default.
 */
export const DefaultUnderwriterCollateralAmount: bigint = 1000n

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
 * Build the default underwriter-collateral set: one
 * {@link ChainTokenAmount} per
 * {@link DefaultUnderwriterCollateralPairs} entry, each amounting to
 * {@link DefaultUnderwriterCollateralAmount} base units.
 *
 * Constructed via the message-type `.create()` factory so the
 * returned messages are fully-initialised proto instances (suitable
 * for both `.toJson()` round-tripping and field-level access).
 *
 * @returns A fresh array (the caller may mutate without aliasing the
 *   defaults). Returns the per-underwriter list shape — fan-out to all
 *   underwriters happens in `loadUnderwriterCollateral`.
 */
export function buildDefaultUnderwriterCollateral(): ChainTokenAmount[] {
  return DefaultUnderwriterCollateralPairs.map(({ chain, tokenKind }) =>
    ChainTokenAmount.create({
      chain: ChainId.create({ kind: chain, id: 0 }),
      amount: TokenAmount.create({
        kind: tokenKind,
        amount: DefaultUnderwriterCollateralAmount
      })
    })
  )
}
