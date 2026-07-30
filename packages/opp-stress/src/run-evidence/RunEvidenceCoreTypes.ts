import { RunEvidenceSchemaVersion } from "./runEvidenceConstants.js"
import type {
  RunEvidenceClusterConfigState,
  RunEvidenceConfigUnavailableReason,
  RunEvidenceParseErrorCode,
  RunEvidenceParseResultKind,
  RunEvidencePath,
  RunEvidenceRecordKind,
  RunEvidenceSetupRefState
} from "./runEvidenceConstants.js"

/** A non-negative base-ten integer encoded without JSON precision loss. */
export type RunEvidenceDecimal = `${bigint}`

/** Absolute source paths required to reproduce a run. */
export interface RunEvidenceProvenance {
  /** Absolute normalized wire-sysio build path used by the run. */
  readonly wireBuildPath: string
  /** Absolute normalized wire-ethereum source path used by the run. */
  readonly ethereumPath: string
  /** Absolute normalized wire-solana source path used by the run. */
  readonly solanaPath: string
}

/** Runtime identity captured with the manifest. */
export interface RunEvidenceRuntime {
  /** Node.js version that executed the run. */
  readonly nodeVersion: string
  /** Operating-system platform reported by Node.js. */
  readonly platform: string
  /** Processor architecture reported by Node.js. */
  readonly architecture: string
}

/** Ramp configuration persisted in the manifest. */
export interface RunEvidenceRampConfig {
  /** Account count submitted by the first ramp iteration. */
  readonly initialCount: number
  /** Multiplicative account-count increase between iterations. */
  readonly multiplier: number
  /** Inclusive maximum account count allowed by the controller. */
  readonly maxCount: number
  /** Deadline in milliseconds for each workload phase. */
  readonly phaseTimeoutMs: number
}

/** Snapshot state before cluster configuration is created. */
export interface RunEvidencePendingClusterConfigSnapshot {
  /** State before cluster configuration is created. */
  readonly kind: RunEvidenceClusterConfigState.Pending
}

/** Snapshot state after cluster configuration bytes are committed. */
export interface RunEvidenceCapturedClusterConfigSnapshot {
  /** State after cluster configuration bytes are committed. */
  readonly kind: RunEvidenceClusterConfigState.Captured
  /** Fixed run-relative config snapshot path. */
  readonly path: RunEvidencePath.ClusterConfigSnapshot
  /** Full lowercase SHA-256 digest of the committed snapshot bytes. */
  readonly sha256: string
}

/** Snapshot state when setup failed before cluster configuration existed. */
export interface RunEvidenceUnavailableClusterConfigSnapshot {
  /** State when setup failed before cluster configuration existed. */
  readonly kind: RunEvidenceClusterConfigState.Unavailable
  /** Typed reason no cluster configuration snapshot can exist. */
  readonly reason: RunEvidenceConfigUnavailableReason.ClusterConfigNotCreated
}

/** Lifecycle-discriminated state of the immutable cluster-config snapshot. */
export type RunEvidenceClusterConfigSnapshot =
  | RunEvidencePendingClusterConfigSnapshot
  | RunEvidenceCapturedClusterConfigSnapshot
  | RunEvidenceUnavailableClusterConfigSnapshot

/** Relative path and digest of one immutable OPP artifact file. */
export interface RunEvidenceArtifactFile {
  /** Portable run-relative immutable artifact path. */
  readonly path: string
  /** Full lowercase SHA-256 digest of the committed artifact bytes. */
  readonly sha256: string
}

/** First committed immutable data and metadata references for one OPP key. */
export interface RunEvidenceImmutableArtifactRefs {
  /** Immutable raw envelope-data file reference. */
  readonly data: RunEvidenceArtifactFile
  /** Immutable envelope-metadata file reference. */
  readonly metadata: RunEvidenceArtifactFile
}

/** Manifest artifact entry used to recompute accepted OPP observations. */
export interface RunEvidenceArtifact {
  /** Canonical envelope storage key shared by the artifact pair. */
  readonly baseKey: string
  /** First immutable data and metadata refs retained for the key. */
  readonly firstImmutableRefs: RunEvidenceImmutableArtifactRefs
  /** Observation ordinal that first accepted the immutable pair. */
  readonly firstAcceptedObservationOrdinal: RunEvidenceDecimal
  /** Latest observation ordinal whose metadata evolution was accepted. */
  readonly lastAcceptedObservationOrdinal: RunEvidenceDecimal
  /** Sorted batch-operator names from the latest accepted metadata. */
  readonly lastAcceptedBatchOpNames: readonly string[]
}

/** Explicit setup state before setup.json has been committed. */
export interface RunEvidencePendingSetupRef {
  /** Pending marker legal only for an initializing manifest. */
  readonly kind: RunEvidenceSetupRefState.Pending
}

/** Immutable setup.json reference after setup record commit. */
export interface RunEvidenceSetupRecordRef {
  /** Fixed setup record path. */
  readonly path: RunEvidencePath.Setup
  /** Full lowercase SHA-256 digest of committed setup record bytes. */
  readonly sha256: string
}

/** Immutable reference to one zero-based iteration record. */
export interface RunEvidenceIterationRecordRef {
  /** Fixed six-digit path for the referenced iteration index. */
  readonly path: `${RunEvidencePath.Iterations}/${string}.json`
  /** Full lowercase SHA-256 digest of committed iteration record bytes. */
  readonly sha256: string
}

/** Immutable terminal.json reference after terminal record commit. */
export interface RunEvidenceTerminalRecordRef {
  /** Fixed terminal record path. */
  readonly path: RunEvidencePath.Terminal
  /** Full lowercase SHA-256 digest of committed terminal record bytes. */
  readonly sha256: string
}

/** Record refs before setup has committed. */
export interface RunEvidenceInitializingRecordRefs {
  /** Explicit pending setup state. */
  readonly setup: RunEvidencePendingSetupRef
  /** No iteration can commit before setup. */
  readonly iterations: readonly []
  /** No terminal can commit before setup. */
  readonly terminal: null
}

/** Record refs after setup has committed. */
export interface RunEvidenceCommittedRecordRefs {
  /** Immutable setup record ref. */
  readonly setup: RunEvidenceSetupRecordRef
  /** Contiguous immutable iteration record refs. */
  readonly iterations: readonly RunEvidenceIterationRecordRef[]
  /** Immutable terminal ref after terminal commit, otherwise null. */
  readonly terminal: RunEvidenceTerminalRecordRef | null
}

/** Lifecycle-discriminated immutable record refs stored by the manifest. */
export type RunEvidenceRecordRefs =
  RunEvidenceInitializingRecordRefs | RunEvidenceCommittedRecordRefs

/** Typed reason an unknown value did not parse as clean schema v1. */
export interface RunEvidenceParseError {
  /** Stable parse-failure discriminant. */
  readonly kind: RunEvidenceParseResultKind.Failure
  /** Schema record boundary that rejected the value. */
  readonly record: RunEvidenceRecordKind
  /** Stable classification of schema-version or shape failure. */
  readonly code: RunEvidenceParseErrorCode
}

/** Successful schema-v1 parse of an unknown-boundary value. */
interface RunEvidenceParseSuccess<T> {
  /** Indicates successful schema parsing. */
  readonly ok: true
  /** Original value narrowed to its schema-v1 type. */
  readonly value: T
}

/** Typed non-throwing schema-v1 parse failure. */
interface RunEvidenceParseFailure {
  /** Indicates typed schema parsing failure. */
  readonly ok: false
  /** Stable non-throwing parse error. */
  readonly error: RunEvidenceParseError
}

/** Expected parse outcome for an unknown-boundary schema-v1 value. */
export type RunEvidenceParseResult<T> =
  RunEvidenceParseSuccess<T> | RunEvidenceParseFailure

/** Schema version literal shared by every persisted record type. */
export type RunEvidenceVersion = typeof RunEvidenceSchemaVersion
