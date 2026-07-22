import type {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle
} from "./runEvidenceTypes.js"

/** Stable verifier outcomes used by the library and CLI exit policy. */
export enum RunEvidenceVerificationVerdict {
  Invalid = "invalid",
  InProgress = "verified_in_progress",
  NonSuccess = "verified_non_success",
  Saturated = "verified_saturated"
}

/** Stable evidence-defect classifications emitted without throwing. */
export enum RunEvidenceVerificationIssueCode {
  AncestorSymlink = "ancestor_symlink",
  RootSymlink = "root_symlink",
  RootNotDirectory = "root_not_directory",
  NonCanonicalRoot = "noncanonical_root",
  RootChanged = "root_changed",
  PathOutsideRun = "path_outside_run",
  MissingEntry = "missing_entry",
  ExtraEntry = "extra_entry",
  SymlinkEntry = "symlink_entry",
  NonRegularEntry = "nonregular_entry",
  UnexpectedDirectory = "unexpected_directory",
  ReadFailed = "read_failed",
  FileChanged = "file_changed",
  InvalidJson = "invalid_json",
  InvalidManifest = "invalid_manifest",
  InvalidSetup = "invalid_setup",
  InvalidIteration = "invalid_iteration",
  InvalidTerminal = "invalid_terminal",
  InvalidArtifact = "invalid_artifact",
  InvalidProvenance = "invalid_provenance",
  NonCanonicalJson = "noncanonical_json",
  HashMismatch = "hash_mismatch",
  ReferenceMismatch = "reference_mismatch",
  LifecycleMismatch = "lifecycle_mismatch",
  InvalidArtifactKey = "invalid_artifact_key",
  ArtifactHashMismatch = "artifact_hash_mismatch",
  DataDecodeFailed = "data_decode_failed",
  MetadataDecodeFailed = "metadata_decode_failed",
  DataChecksumMismatch = "data_checksum_mismatch",
  MetadataChecksumMismatch = "metadata_checksum_mismatch",
  EpochMismatch = "epoch_mismatch",
  InvalidOperators = "invalid_operators",
  PublisherClaimMismatch = "publisher_claim_mismatch",
  IncompleteArtifactPair = "incomplete_artifact_pair",
  UndeclaredArtifactRef = "undeclared_artifact_ref",
  ArtifactRefOverlap = "artifact_ref_overlap",
  MetricMismatch = "metric_mismatch",
  TelemetryMismatch = "telemetry_mismatch",
  IterationMismatch = "iteration_mismatch",
  AccountRampMismatch = "account_ramp_mismatch",
  CampaignMismatch = "campaign_mismatch",
  TerminalMismatch = "terminal_mismatch",
  ManifestMismatch = "manifest_mismatch"
}

/** One deterministic JSON-safe verifier issue. */
export type RunEvidenceVerificationIssue = {
  /** Stable machine-readable defect code. */
  readonly code: RunEvidenceVerificationIssueCode
  /** Run-relative path or `$run` for a run-wide defect. */
  readonly path: string
  /** Concise deterministic comparison or failure detail. */
  readonly detail: string
}

/** Independently recomputed metrics for one declared phase. */
export type RunEvidenceRecomputedPhase = {
  readonly label: string
  readonly endpoint: RunEvidenceEndpoint
  readonly envelopeCount: number
  readonly envelopeByteSizes: readonly number[]
  readonly epochEnvelopeIndexes: readonly number[]
  readonly solanaOversized: boolean
  readonly saturated: boolean
}

/** Independently recomputed result for one contiguous iteration. */
export type RunEvidenceRecomputedIteration = {
  readonly iterationIndex: number
  readonly accountCount: number
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly phases: readonly RunEvidenceRecomputedPhase[]
}

/** Independently recomputed campaign partition for one required endpoint. */
export type RunEvidenceRecomputedEndpoint = {
  readonly endpoint: RunEvidenceEndpoint
  readonly saturated: boolean
  readonly supportingPhases: readonly string[]
}

/** Structurally checked publisher claims that later immutable bytes cannot prove. */
export type RunEvidencePublisherClaim = {
  readonly baseKey: string
  readonly lastAcceptedObservationOrdinal: string
  readonly lastAcceptedBatchOpNames: readonly string[]
}

/** Complete JSON-safe offline verification report. */
export type RunEvidenceVerificationReport = {
  readonly schemaVersion: 1
  readonly runDirectory: string
  readonly valid: boolean
  readonly verdict: RunEvidenceVerificationVerdict
  readonly lifecycle: RunEvidenceLifecycle | null
  readonly verifiedSaturated: boolean
  readonly issues: readonly RunEvidenceVerificationIssue[]
  readonly checkedFiles: readonly string[]
  readonly recomputedEndpoints: readonly RunEvidenceRecomputedEndpoint[]
  readonly recomputedIterations: readonly RunEvidenceRecomputedIteration[]
  readonly publisherClaims: readonly RunEvidencePublisherClaim[]
  readonly limitations: readonly string[]
}

/** Programmer/invocation error raised before evidence can be inspected. */
export class RunEvidenceVerifierInvocationError extends Error {
  readonly name = "RunEvidenceVerifierInvocationError"

  /** Create an invocation error for an unusable explicit run directory. */
  constructor(
    readonly runDirectory: string,
    message: string
  ) {
    super(message)
  }
}
