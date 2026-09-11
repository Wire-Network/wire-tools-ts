import type { ChainKind } from "@wireio/opp-typescript-models"

/** Provenance categories for distribution-claim credit sets. */
export enum DistributionClaimBootstrapSource {
  configuredFile = "configuredFile",
  fallback = "fallback",
  additive = "additive"
}

/** One normalized WIRE-atomic distribution-claim credit. */
export interface DistributionClaimBootstrapCredit {
  /** Lowercase native-address hex without a prefix. */
  native_address: string
  /** Positive WIRE-atomic amount assigned to the native address. */
  wire_atomic: bigint
}

/** One caller-supplied, pre-batching credit set for a native chain. */
export interface DistributionClaimBootstrapInputCreditSet {
  /** Native chain whose address and decimal conventions produced the credits. */
  chain: ChainKind.EVM | ChainKind.SVM
  /** Converted WIRE-atomic credits. */
  credits: DistributionClaimBootstrapCredit[]
  /** Source-native dust discarded during decimal conversion. */
  droppedDust: bigint
}

/** One normalized credit set with generic provenance. */
export interface DistributionClaimBootstrapCreditSet extends DistributionClaimBootstrapInputCreditSet {
  /** Origin used in deterministic summaries and source selection. */
  source: DistributionClaimBootstrapSource
}

/** Generic inputs used to construct one distribution-claim bootstrap plan. */
export interface DistributionClaimBootstrapOptions {
  /** Credits loaded from configured bootstrap data. */
  configuredCreditSets?: DistributionClaimBootstrapInputCreditSet[]
  /** Per-chain fallbacks used only when configured data is absent for that chain. */
  fallbackCreditSets?: DistributionClaimBootstrapInputCreditSet[]
  /** Credits always merged after configured/fallback selection and before batching. */
  additiveCreditSets?: DistributionClaimBootstrapInputCreditSet[]
  /** Optional transaction batch size from 1 through the importer maximum. */
  batchSize?: number
  /** First global dclaim row id available for the planned batches. Defaults to 1. */
  firstUnmappedId?: bigint
}
