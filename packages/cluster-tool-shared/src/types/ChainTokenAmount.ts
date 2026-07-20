import { TokenAmount } from "@wireio/opp-typescript-models"
import { z } from "zod"

/** The JSON value `TokenAmount.fromJson` accepts (derived, never re-declared). */
type TokenAmountJson = Parameters<typeof TokenAmount.fromJson>[0]

/** True when `json` decodes as a `TokenAmount` (fromJson does not throw). */
function isTokenAmountJson(json: unknown): boolean {
  try {
    TokenAmount.fromJson(json as TokenAmountJson)
    return true
  } catch {
    return false
  }
}

/**
 * The proto-JSON input a `TokenAmount` decodes from — validated up front (the
 * refine actually runs `fromJson`) exactly like `OperatorTypeCodec`'s typed
 * string+refine, so DECODE never sees a value `fromJson` would throw on. That
 * keeps a malformed `amount` a proper zod ISSUE — `SchemaCodec.check` returns
 * `false` (never throws) and `deserialize` surfaces the issue-path message, not
 * a raw proto error.
 */
const TokenAmountJsonSchema = z
  .unknown()
  .refine(isTokenAmountJson, { message: "invalid TokenAmount JSON" })

/**
 * zod v4 codec bridging the proto `TokenAmount` bigint round-trip: the WIRE
 * (input) side is the validated proto JSON value (`amount.amount` int64 as a
 * string); the DECODED (output) side is a live `TokenAmount`. `deserialize` runs
 * DECODE (`fromJson`, safe — the input schema already validated it); `serialize`
 * runs ENCODE (`toJson`) — the bigint-safe projection lives IN the schema.
 */
export const TokenAmountCodec = z.codec(
  TokenAmountJsonSchema,
  z.custom<TokenAmount>(),
  {
    decode: (json: unknown): TokenAmount =>
      TokenAmount.fromJson(json as TokenAmountJson),
    encode: (amount: TokenAmount): unknown => TokenAmount.toJson(amount)
  }
)

/**
 * Harness-local (chain, token) amount tuple. The previous proto-emitted
 * `ChainTokenAmount` was removed in the v6 data-model refactor — `Token.code`
 * is globally unique now, so the proto carries `TokenAmount` (just `token_code`
 * + `amount`) without a redundant chain tag. We still need the chain dimension
 * at the harness layer (per-underwriter collateral fans out across
 * `{ETH, SOL, WIRE}`), so this pairs each `TokenAmount` (via {@link
 * TokenAmountCodec}) with its `chain_code` (slug_name / uint64).
 */
export const ChainTokenAmountSchema = z.object({
  /** SlugName / uint64 chain identifier (e.g. `SlugName.from("ETHEREUM")`). */
  chain_code: z.number(),
  /** Token amount carrying its own slug_name + int64 amount. */
  amount: TokenAmountCodec
})

/**
 * Harness-local (chain, token) amount tuple — the schema-inferred shape of
 * {@link ChainTokenAmountSchema}. Persisted through `cluster-config.json`; the
 * bigint `amount.amount` round-trips losslessly via {@link TokenAmountCodec}.
 */
export type ChainTokenAmount = z.infer<typeof ChainTokenAmountSchema>
