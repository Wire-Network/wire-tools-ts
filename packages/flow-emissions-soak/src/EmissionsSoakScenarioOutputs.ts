import {
  outputKey,
  serializeBatchForClio,
  type ImportSeedResult
} from "@wireio/cluster-tool"
import type { ControlledStakerIdentity } from "./EmissionsSoakScenarioSyntheticDump.js"

/**
 * A clio-ready importseed batch — `wire_atomic` serialized as a decimal string
 * (the dclaim ABI's int64 accepts string input; `JSON.stringify` can't carry a
 * BigInt). Derived from the harness serializer, never re-declared.
 */
export type SerializedImportSeedBatch = ReturnType<typeof serializeBatchForClio>

/**
 * The JSON-safe summary of one chain's `convertImportSeed` result — the
 * clio-ready batches plus the conversion stats the old suite logged/asserted.
 */
export interface SeedConversionSummary {
  /** The clio-ready importseed batches, in push order. */
  batches: SerializedImportSeedBatch[]
  /** Unique addresses observed (purchasers ∪ stakers after dedup). */
  uniqueAddresses: number
  /** Credits with `wire_atomic > 0` after flooring. */
  nonZeroCredits: number
  /** Total WIRE atomic credited across all credits (decimal string). */
  totalAtomic: string
  /** Sub-atomic units dropped by the conversion floor (decimal string). */
  droppedDust: string
}

/**
 * Fold a raw {@link ImportSeedResult} into its JSON-safe
 * {@link SeedConversionSummary} (batches serialized for clio, BigInt stats
 * stringified).
 *
 * @param result - The `convertImportSeed` result.
 * @return The JSON-safe summary.
 */
export function toSeedConversionSummary(result: ImportSeedResult): SeedConversionSummary {
  return {
    batches: result.batches.map(serializeBatchForClio),
    uniqueAddresses: result.uniqueAddresses,
    nonZeroCredits: result.nonZeroCredits,
    totalAtomic: result.totalAtomic.toString(),
    droppedDust: result.droppedDust.toString()
  }
}

/** The controlled-staker roster every claimer/verify step reads. */
export const ClaimantIdentitiesKey = outputKey<ControlledStakerIdentity[]>(
  "emissions-soak:claimant-identities",
  "Controlled-staker identities (WIRE account, ETH address, HD index)"
)

/** The ETH-side importseed conversion (batches + stats). */
export const EthereumSeedConversionKey = outputKey<SeedConversionSummary>(
  "emissions-soak:ethereum-seed-conversion",
  "CHAIN_KIND_EVM importseed batches + conversion stats"
)

/** The SOL-side importseed conversion (batches + stats). */
export const SolanaSeedConversionKey = outputKey<SeedConversionSummary>(
  "emissions-soak:solana-seed-conversion",
  "CHAIN_KIND_SVM importseed batches + conversion stats"
)

/** Per-account WIRE balances (raw 9-decimal atomic) snapshotted pre-claim. */
export const PreClaimBalancesKey = outputKey<Record<string, bigint>>(
  "emissions-soak:preclaim-balances",
  "Controlled stakers' WIRE balances before their dclaim claims"
)
