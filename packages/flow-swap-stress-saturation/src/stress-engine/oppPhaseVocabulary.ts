import type {
  EnvelopeBaseline,
  EnvelopeBaselineIdentity
} from "../envelope-integrity/index.js"

/**
 * The closed vocabulary the OPP phase-metric layer is written against.
 *
 * These names date from the run-evidence schema that once persisted them, and
 * are kept verbatim so the ~12 call sites and their tests stay untouched — the
 * types themselves are plain measurement vocabulary with no persistence
 * dependency, which is why they outlived the store.
 */

/** A non-negative base-ten integer encoded without JSON precision loss. */
export type RunEvidenceDecimal = `${bigint}`

/** Endpoint labels naming one direction of the OPP channel. */
export enum RunEvidenceEndpoint {
  OutpostEthereumDepot = "OUTPOST_ETHEREUM_DEPOT",
  OutpostSolanaDepot = "OUTPOST_SOLANA_DEPOT",
  DepotOutpostEthereum = "DEPOT_OUTPOST_ETHEREUM",
  DepotOutpostSolana = "DEPOT_OUTPOST_SOLANA"
}

/** Canonical endpoint set used by runtime guards. */
export const RunEvidenceEndpoints = [
  RunEvidenceEndpoint.OutpostEthereumDepot,
  RunEvidenceEndpoint.OutpostSolanaDepot,
  RunEvidenceEndpoint.DepotOutpostEthereum,
  RunEvidenceEndpoint.DepotOutpostSolana
] as const

/** Saturation strategies; a member change alters metric recomputation. */
export enum RunEvidenceSaturationStrategy {
  Rollover = "rollover",
  ByteThreshold = "byte_threshold"
}

/** Pre-phase baseline membership a collection pass measures against. */
export interface RunEvidencePhaseBaseline {
  /** Stable identity linking every observation to the same baseline. */
  readonly identity: EnvelopeBaselineIdentity
  /** Canonically sorted all-key membership captured before submission. */
  readonly baseKeys: EnvelopeBaseline["baseKeys"]
  /** Monotonic observation ordinal allocated before collection. */
  readonly observationOrdinal: RunEvidenceDecimal
  /** Artifact refs already present when the baseline was captured. */
  readonly artifactRefs: readonly string[]
}

/** Observation bounds used to independently select a phase's artifacts. */
export interface RunEvidencePhaseWindow {
  /** Inclusive observational timestamp lower bound. */
  readonly startedAtMs: RunEvidenceDecimal
  /** Inclusive observational timestamp upper bound. */
  readonly endedAtMs: RunEvidenceDecimal
  /** Inclusive source epoch lower bound. */
  readonly epochStart: RunEvidenceDecimal
  /** Inclusive source epoch upper bound. */
  readonly epochEnd: RunEvidenceDecimal
}
