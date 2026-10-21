import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import { SolanaAddressPattern } from "./chainAddressPatterns.js"
import { UnsignedDecimalStringSchema } from "./decimalStrings.js"

/** An export's `allocationHash`: a lowercase hex SHA-256 digest. */
export const SolanaGenesisAllocationHashPattern = /^[a-f0-9]{64}$/

/**
 * One wallet's allocation in the Solana outpost's genesis export (capital-index
 * `solana:genesis`, taken after the outpost entered `Launching`). liqSOL amounts carry 9
 * decimals; pretoken amounts carry 8.
 */
export const SolanaGenesisBalanceSchema = z.object({
  /** The wallet: its base58 Ed25519 public key, the key the depot parks credits under. */
  address: z.string().regex(SolanaAddressPattern),
  /** The wallet's `OutpostAccount` PDA, when it has one. */
  outpostAccount: z.string().nullable(),
  /** The wallet's `UserPretokenRecord` PDA, when it has one. */
  pretokenRecord: z.string().nullable(),
  /** liqSOL the wallet syndicated and still owns (`OutpostAccount.staked_liqsol`). */
  syndicatedLiqsol: UnsignedDecimalStringSchema,
  /** liqSOL the wallet spent on pretokens: protocol-owned from then on. */
  purchasedLiqsol: UnsignedDecimalStringSchema,
  /** Pool shares behind the syndicated liqSOL. */
  stakedShares: UnsignedDecimalStringSchema,
  /** Pool shares behind the purchased liqSOL. */
  purchasedShares: UnsignedDecimalStringSchema,
  /** Pretokens bought directly. */
  directlyPurchasedPretokens: UnsignedDecimalStringSchema,
  /** Pretokens earned as yield. */
  pretokenYield: UnsignedDecimalStringSchema,
  /** Pretokens bought plus pretoken yield: the wallet's WIRE claim. */
  totalPretokens: UnsignedDecimalStringSchema
})
/** One wallet's allocation — the shape of {@link SolanaGenesisBalanceSchema}. */
export type SolanaGenesisBalance = z.infer<typeof SolanaGenesisBalanceSchema>

/** The units every amount of a genesis export is denominated in. */
export const SolanaGenesisUnitsSchema = z.object({
  /** liqSOL decimals. */
  liqsolDecimals: z.literal(9),
  /** Pretoken decimals (8, not WIRE's 9). */
  pretokenDecimals: z.literal(8),
  /** The fixed-point scale of the pool share index. */
  indexScale: z.literal("1000000000000")
})
/** The export's units — the shape of {@link SolanaGenesisUnitsSchema}. */
export type SolanaGenesisUnits = z.infer<typeof SolanaGenesisUnitsSchema>

/**
 * The export's pool reconciliation: what the pool ATA holds and how much of it backs the
 * depot's launch mint (the launch-flip runbook's step 3b, computed by the exporter).
 */
export const SolanaGenesisAccountingSchema = z.object({
  /** The outpost's `WireState` at export time; a genesis export is taken in `Launching`. */
  wireState: z.literal("Launching"),
  /** The export mode; only a `genesis` export is importable. */
  mode: z.literal("genesis"),
  /** The Solana epoch the export read. */
  epoch: UnsignedDecimalStringSchema,
  /** The pool authority PDA. */
  poolAuthority: z.string(),
  /** liqSOL in the pool ATA. */
  poolBalance: UnsignedDecimalStringSchema,
  /** Pretokens bought with pool yield. */
  poolPretokens: UnsignedDecimalStringSchema,
  /** Pool pretokens attributed to wallets. */
  allocatedPretokenYield: UnsignedDecimalStringSchema,
  /** Pool pretokens no wallet was attributed. */
  unallocatedPoolPretokens: UnsignedDecimalStringSchema,
  /** Pretokens wallets bought directly. */
  directlyPurchasedPretokens: UnsignedDecimalStringSchema,
  /** Every wallet's pretokens. */
  totalUserPretokens: UnsignedDecimalStringSchema,
  /** Pretokens the tranche manager sold. */
  totalPretokensSold: UnsignedDecimalStringSchema,
  /** Pool shares no wallet owns. */
  ownerlessShares: UnsignedDecimalStringSchema,
  /** Claimed but unreported liqSOL yield, reported after launch and so never imported. */
  unreportedLiqsolYield: UnsignedDecimalStringSchema,
  /** The pool balance minus the unreported yield: what may back the launch mint. */
  backingAvailable: UnsignedDecimalStringSchema,
  /** `backingAvailable` minus the syndicated principal: the LIQSOL pool's liq side. */
  maxInitialChainAmount: UnsignedDecimalStringSchema,
  /** Reconciliation failures; a genesis export is only produced with none. */
  issues: z.array(z.string()),
  /** The units of every amount in the export. */
  units: SolanaGenesisUnitsSchema,
  /**
   * The highest tranche price the Solana LCO reached, in USD with 8 decimals. Absent until
   * the exporter adds it; the import then uses the configured or placeholder price.
   */
  highestTranchePriceUsd: UnsignedDecimalStringSchema.optional()
})
/** The export's pool reconciliation — the shape of {@link SolanaGenesisAccountingSchema}. */
export type SolanaGenesisAccounting = z.infer<
  typeof SolanaGenesisAccountingSchema
>

/** One raw source account the exporter read, kept as evidence of what it read. */
export const SolanaGenesisEvidenceSchema = z.object({
  /** The account address. */
  address: z.string(),
  /** The owning program. */
  owner: z.string(),
  /** The finalized slot the account was read at. */
  slot: z.number().int(),
  /** The account data. */
  dataBase64: z.string()
})
/** One evidence account — the shape of {@link SolanaGenesisEvidenceSchema}. */
export type SolanaGenesisEvidence = z.infer<typeof SolanaGenesisEvidenceSchema>

/**
 * The Solana outpost's genesis export (capital-index `solana:genesis`): every wallet's
 * allocation and the pool reconciliation, read from the frozen `Launching` state. The depot
 * bootstrap imports it (`sysio.synd::importsynd`, `sysio.dclaim::importseed`,
 * `sysio.liq::regliqpool`).
 */
export const SolanaGenesisSnapshotSchema = z.object({
  /** The export format version. */
  schemaVersion: z.literal(1),
  /** The `liqsol_core` program the export read. */
  programId: z.string(),
  /** Hash over every wallet allocation, identical across exports of the same frozen state. */
  allocationHash: z.string().regex(SolanaGenesisAllocationHashPattern),
  /** Every wallet with an allocation. */
  balances: z.array(SolanaGenesisBalanceSchema),
  /** The pool reconciliation. */
  accounting: SolanaGenesisAccountingSchema,
  /** The raw accounts read; the import does not consume them. */
  evidence: z.array(SolanaGenesisEvidenceSchema).optional()
})
/** The Solana outpost's genesis export — the shape of {@link SolanaGenesisSnapshotSchema}. */
export type SolanaGenesisSnapshot = z.infer<typeof SolanaGenesisSnapshotSchema>

/** Validated codec for the `--solana-bootstrap-json-file` export. */
export const SolanaGenesisSnapshotSchemaCodec =
  SchemaCodec.create<SolanaGenesisSnapshot>(SolanaGenesisSnapshotSchema)
