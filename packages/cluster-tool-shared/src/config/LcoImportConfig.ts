import { LiqPoolSpec } from "@wireio/opp-typescript-models"
import { getValue } from "@wireio/shared"
import { z } from "zod"

import { UnsignedDecimalStringSchema } from "../types/decimalStrings.js"

/**
 * Decimals of every USD price the LCO import takes — a native token's launch price and a
 * tranche price both carry 8, as the tranche manager and Chainlink price feeds do.
 */
export const LcoImportUsdPriceDecimals = 8

/** The JSON value `LiqPoolSpec.fromJson` accepts (derived, never re-declared). */
type LiqPoolSpecJson = Parameters<typeof LiqPoolSpec.fromJson>[0]

/** True when `json` decodes as a `LiqPoolSpec` (`fromJson` does not throw). */
function isLiqPoolSpecJson(json: unknown): boolean {
  return getValue(
    () => LiqPoolSpec.fromJson(json as LiqPoolSpecJson) != null,
    false
  )
}

/**
 * zod codec bridging the generated `LiqPoolSpec` (`sysio.opp.bootstrap`) to its own proto
 * JSON — the wire side is validated proto JSON (camelCase or proto field names, absent
 * fields zero), the decoded side a live `LiqPoolSpec`. The proto owns the shape; this only
 * hands it to `fromJson` / `toJson`.
 */
export const LiqPoolSpecCodec = z.codec(
  z.unknown().refine(isLiqPoolSpecJson, { message: "invalid LiqPoolSpec JSON" }),
  z.custom<LiqPoolSpec>(),
  {
    decode: (json: unknown): LiqPoolSpec =>
      LiqPoolSpec.fromJson(json as LiqPoolSpecJson),
    encode: (spec: LiqPoolSpec): unknown => LiqPoolSpec.toJson(spec)
  }
)

/**
 * One outpost chain's launch-data import: the chain's frozen pre-launch export and the
 * economic values that price its LCO yield pool. A `null` value is not set; the import
 * then falls back to a named placeholder, lists it in the bootstrap Report, and refuses
 * external outposts.
 */
export const LcoImportChainConfigSchema = z.object({
  /** Absolute path of the chain's frozen pre-launch export (`--<chain>-bootstrap-json-file`). */
  bootstrapJsonFile: z.string(),
  /**
   * The chain's native token price at launch, in USD with {@link LcoImportUsdPriceDecimals}
   * decimals. It prices the pool's liq side for its WIRE side.
   */
  nativePriceUsd: UnsignedDecimalStringSchema.nullable().default(null),
  /**
   * The highest tranche price the LCO reached, USD per WIRE with
   * {@link LcoImportUsdPriceDecimals} decimals — the price the pool's WIRE side is
   * computed at. `null` takes the export's own value when it carries one.
   */
  highestTranchePriceUsd: UnsignedDecimalStringSchema.nullable().default(null),
  /**
   * The pool's tuning as `LiqPoolSpec` JSON: `fee`, `lockedShares`, `conversionHorizonSec`,
   * `depthCapBps`, `clipFloor`, and optionally `name` / `description`. The import derives
   * the chain, token, pair symbol and every amount itself.
   */
  pool: LiqPoolSpecCodec.nullable().default(null)
})
/** One chain's launch-data import — the shape of {@link LcoImportChainConfigSchema}. */
export type LcoImportChainConfig = z.infer<typeof LcoImportChainConfigSchema>

/**
 * The cluster's launch-data (LCO) import, persisted in `cluster-config.json`: per chain,
 * the frozen export and its pricing; `null` for a chain with no export.
 */
export const LcoImportConfigSchema = z.object({
  /** The Ethereum outpost's import, or `null`. */
  ethereum: LcoImportChainConfigSchema.nullable().default(null),
  /** The Solana outpost's import, or `null`. */
  solana: LcoImportChainConfigSchema.nullable().default(null),
  /**
   * The WIRE account the bootstrap funds `sysio.dclaim` from with the imported WIRE
   * credits. `null` falls back to a placeholder.
   */
  dclaimFundingAccount: z.string().nullable().default(null)
})
/** The cluster's launch-data import — the shape of {@link LcoImportConfigSchema}. */
export type LcoImportConfig = z.infer<typeof LcoImportConfigSchema>

/**
 * Caller options for one chain: its pricing members, every one optional (the export rides
 * its own flag). Strict, so a misspelled member fails instead of leaving a placeholder.
 */
export const LcoImportChainOptionsSchema = LcoImportChainConfigSchema.omit({
  bootstrapJsonFile: true
})
  .partial()
  .strict()
/** Caller options for one chain — the shape of {@link LcoImportChainOptionsSchema}. */
export type LcoImportChainOptions = z.infer<typeof LcoImportChainOptionsSchema>

/**
 * Caller options for the launch-data import (flag-less: a build-options document or a
 * flow's scenario defaults sets them). The export files themselves are the
 * `--ethereum-bootstrap-json-file` / `--solana-bootstrap-json-file` flags. Strict, like
 * the rest of the options document.
 */
export const LcoImportOptionsSchema = z
  .object({
    /** The Ethereum chain's pricing. */
    ethereum: LcoImportChainOptionsSchema.optional(),
    /** The Solana chain's pricing. */
    solana: LcoImportChainOptionsSchema.optional(),
    /** The account that funds `sysio.dclaim`. */
    dclaimFundingAccount: z.string().optional()
  })
  .strict()
/** Caller options for the launch-data import — the shape of {@link LcoImportOptionsSchema}. */
export type LcoImportOptions = z.infer<typeof LcoImportOptionsSchema>
