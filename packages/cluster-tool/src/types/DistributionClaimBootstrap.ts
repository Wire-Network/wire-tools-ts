import type { ChainKind } from "@wireio/opp-typescript-models"

/** Provenance categories for distribution-claim credit sets. */
export enum DistributionClaimBootstrapSource {
  configuredFile = "configuredFile",
  synthetic = "synthetic",
  controlled = "controlled"
}

/** One normalized WIRE-atomic distribution-claim credit. */
export interface DistributionClaimBootstrapCredit {
  /** Lowercase native-address hex without a prefix. */
  native_address: string
  /** Positive WIRE-atomic amount assigned to the native address. */
  wire_atomic: bigint
}

/** One pre-batching credit set for a native chain and provenance source. */
export interface DistributionClaimBootstrapCreditSet {
  /** Native chain whose address and decimal conventions produced the credits. */
  chain: ChainKind.EVM | ChainKind.SVM
  /** Origin reported in preflight summaries. */
  source: DistributionClaimBootstrapSource
  /** Converted WIRE-atomic credits. */
  credits: DistributionClaimBootstrapCredit[]
  /** Source-native dust discarded during decimal conversion. */
  droppedDust: bigint
}

/**
 * Programmatic distribution-claim inputs for cluster creation. Fallback sets
 * are used only when the same chain has no configured JSON file; additive sets
 * always merge after configured/fallback conversion and before batching.
 */
export interface DistributionClaimBootstrapOptions {
  /** Per-chain fallback sets suppressed by a configured file for that chain. */
  fallbackCreditSets?: DistributionClaimBootstrapCreditSet[]
  /** Credit sets always merged into the selected configured/fallback inputs. */
  additiveCreditSets?: DistributionClaimBootstrapCreditSet[]
}
