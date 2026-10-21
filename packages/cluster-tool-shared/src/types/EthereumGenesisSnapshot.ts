import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import {
  EvmAddressPattern,
  EvmCompressedPublicKeyPattern
} from "./chainAddressPatterns.js"
import { UnsignedDecimalStringSchema } from "./decimalStrings.js"

/**
 * A staker row of the frozen Ethereum outpost's export — the `/opp/balances` staker row
 * `@wireio/opp-snapshot` computes from the pre-launch OPP stream. Amounts are wei-scale
 * (18 decimals) decimal strings.
 */
export const EthereumGenesisStakerSchema = z.object({
  /** The staker's address (lowercase hex). */
  address: z.string().regex(EvmAddressPattern),
  /**
   * The compressed public key recovered from a transaction the staker signed; `null` when
   * none was recovered (a contract wallet, or an address that never signed one itself).
   */
  pubkey: z.string().regex(EvmCompressedPublicKeyPattern).nullable(),
  /** liqETH shares staked. */
  totalShares: UnsignedDecimalStringSchema,
  /** Net principal (the exporter stores net principal here). */
  totalPrincipalIn: UnsignedDecimalStringSchema,
  /** Always `"0"`: the net principal already accounts for it. */
  totalAmountOut: UnsignedDecimalStringSchema,
  /** Net liqETH principal staked: stakes minus unstakes. */
  netPrincipal: UnsignedDecimalStringSchema,
  /** Always `"0"`: the scaled accumulator is not exposed. */
  yieldClaimed: UnsignedDecimalStringSchema,
  /** Pretokens earned as staking yield. */
  pretokenYield: UnsignedDecimalStringSchema
})
/** One staker row — the shape of {@link EthereumGenesisStakerSchema}. */
export type EthereumGenesisStaker = z.infer<typeof EthereumGenesisStakerSchema>

/** A purchaser row of the frozen Ethereum outpost's export (the `/opp/balances` purchaser row). */
export const EthereumGenesisPurchaserSchema = z.object({
  /** The purchaser's address (lowercase hex). */
  address: z.string().regex(EvmAddressPattern),
  /** Pretokens bought directly. */
  pretokens: UnsignedDecimalStringSchema,
  /** liqETH shares spent on pretokens. */
  liqShares: UnsignedDecimalStringSchema,
  /** liqETH principal spent on pretokens: protocol-owned from then on. */
  liqPrincipalIn: UnsignedDecimalStringSchema,
  /** Always `"0"`: the scaled accumulator is not exposed. */
  yieldClaimed: UnsignedDecimalStringSchema,
  /** Pretokens earned as yield on the purchased principal. */
  pretokenYield: UnsignedDecimalStringSchema,
  /** Pretokens bought plus pretoken yield. */
  totalPretokens: UnsignedDecimalStringSchema
})
/** One purchaser row — the shape of {@link EthereumGenesisPurchaserSchema}. */
export type EthereumGenesisPurchaser = z.infer<
  typeof EthereumGenesisPurchaserSchema
>

/** The export's metadata row: what the computation replayed, and the frozen pool's totals. */
export const EthereumGenesisMetadataSchema = z.object({
  /** The last message replayed. */
  lastMessageId: z.string(),
  /** The last message's timestamp. */
  lastTimestamp: z.string(),
  /** The last liqETH index the stream carried. */
  latestIndex: UnsignedDecimalStringSchema,
  /** Messages replayed. */
  totalMessages: z.number().int().nonnegative(),
  /** Net principal across every staker. */
  totalPrincipal: UnsignedDecimalStringSchema,
  /** Yield lost to flooring. */
  yieldDust: UnsignedDecimalStringSchema,
  /** Net principal across every staker. */
  totalLiqEthStaked: UnsignedDecimalStringSchema,
  /** liqETH principal across every purchaser. */
  totalLiqEthPurchased: UnsignedDecimalStringSchema,
  /** When the computation ran (ISO-8601). */
  generatedAt: z.string(),
  /**
   * The frozen Depositor's `lastPoolLiqBalance` (wei): the booked custody the go-live seeds
   * the syndication pool with. Absent until the exporter adds it; the import then uses a
   * placeholder and refuses external outposts.
   */
  lastPoolLiqBalance: UnsignedDecimalStringSchema.optional(),
  /**
   * The highest tranche price the Ethereum LCO reached, in USD with 8 decimals. Absent until
   * the exporter adds it; the import then uses the configured or placeholder price.
   */
  highestTranchePriceUsd: UnsignedDecimalStringSchema.optional()
})
/** The export's metadata row — the shape of {@link EthereumGenesisMetadataSchema}. */
export type EthereumGenesisMetadata = z.infer<
  typeof EthereumGenesisMetadataSchema
>

/**
 * The frozen Ethereum outpost's pre-launch export: every staker and purchaser position plus
 * the replay metadata — the `/opp/balances` document, taken after the deep freeze. The
 * depot bootstrap imports it (`sysio.synd::importsynd`, `sysio.dclaim::importseed`,
 * `sysio.liq::regliqpool`).
 */
export const EthereumGenesisSnapshotSchema = z.object({
  /** Every staker with a position. */
  stakers: z.array(EthereumGenesisStakerSchema),
  /** Every purchaser with a position. */
  purchasers: z.array(EthereumGenesisPurchaserSchema),
  /** What the export replayed. */
  metadata: EthereumGenesisMetadataSchema
})
/** The frozen Ethereum outpost's export — the shape of {@link EthereumGenesisSnapshotSchema}. */
export type EthereumGenesisSnapshot = z.infer<
  typeof EthereumGenesisSnapshotSchema
>

/** Validated codec for the `--ethereum-bootstrap-json-file` export. */
export const EthereumGenesisSnapshotSchemaCodec =
  SchemaCodec.create<EthereumGenesisSnapshot>(EthereumGenesisSnapshotSchema)
