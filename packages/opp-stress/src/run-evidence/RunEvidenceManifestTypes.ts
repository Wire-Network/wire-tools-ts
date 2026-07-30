import type {
  HealthyOppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryHealth
} from "../envelopeMetricTypes.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceCapturedClusterConfigSnapshot,
  RunEvidenceClusterConfigSnapshot,
  RunEvidenceCommittedRecordRefs,
  RunEvidenceDecimal,
  RunEvidenceInitializingRecordRefs,
  RunEvidencePendingClusterConfigSnapshot,
  RunEvidenceProvenance,
  RunEvidenceRampConfig,
  RunEvidenceRuntime,
  RunEvidenceTerminalRecordRef,
  RunEvidenceVersion
} from "./RunEvidenceCoreTypes.js"
import type {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle
} from "./runEvidenceConstants.js"

/** Manifest fields shared by every lifecycle variant. */
interface ManifestFields {
  /** Clean schema version. */
  readonly schemaVersion: RunEvidenceVersion
  /** Random UUID identifying one allocated evidence run. */
  readonly runId: string
  /** Controller timestamp at evidence allocation. */
  readonly startedAtMs: RunEvidenceDecimal
  /** Controller timestamp of the latest manifest checkpoint. */
  readonly updatedAtMs: RunEvidenceDecimal
  /** Absolute normalized cluster path exercised by the run. */
  readonly clusterPath: string
  /** Controller ramp configuration. */
  readonly rampConfig: RunEvidenceRampConfig
  /** Non-empty unique endpoints required by the campaign. */
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  /** Required endpoints classified as saturated at this checkpoint. */
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  /** Required endpoints not classified as saturated at this checkpoint. */
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  /** Aggregate telemetry health at this checkpoint. */
  readonly telemetry: OppEnvelopeTelemetryHealth
  /** Node.js runtime identity. */
  readonly runtime: RunEvidenceRuntime
  /** Absolute source paths required to reproduce the run. */
  readonly provenance: RunEvidenceProvenance
}

/** Fields contributed once setup captured the immutable cluster configuration. */
interface ActiveManifestOwnFields {
  /** Immutable captured cluster configuration. */
  readonly clusterConfigSnapshot: RunEvidenceCapturedClusterConfigSnapshot
  /** Immutable OPP artifacts accepted by the run. */
  readonly artifacts: readonly RunEvidenceArtifact[]
  /** Aggregate telemetry health at this checkpoint. */
  readonly telemetry: OppEnvelopeTelemetryHealth
}

/** Manifest fields available once setup captured the cluster configuration. */
type ActiveManifestFields = Omit<ManifestFields, "telemetry"> &
  ActiveManifestOwnFields

/** Fields contributed by the pre-setup allocation lifecycle. */
interface InitializingManifestOwnFields {
  /** Pre-setup allocation lifecycle. */
  readonly lifecycle: RunEvidenceLifecycle.Initializing
  /** Initial allocation is retained until setup resolves. */
  readonly preserveCluster: true
  /** Cluster configuration has not been created. */
  readonly clusterConfigSnapshot: RunEvidencePendingClusterConfigSnapshot
  /** Explicit pending setup with no committed iteration or terminal refs. */
  readonly records: RunEvidenceInitializingRecordRefs
  /** No immutable OPP artifacts exist before setup. */
  readonly artifacts: readonly []
}

/** Record refs narrowed to the setup-failure shape. */
interface SetupFailedRecordOwnFields {
  /** Setup fails before any ramp iteration commits. */
  readonly iterations: readonly []
  /** Immutable setup-failure terminal record ref. */
  readonly terminal: RunEvidenceTerminalRecordRef
}

/** Fields contributed by the setup-breakage lifecycle. */
interface SetupFailedManifestOwnFields {
  /** Setup breakage lifecycle. */
  readonly lifecycle: RunEvidenceLifecycle.SetupFailed
  /** Setup failures preserve the cluster and evidence. */
  readonly preserveCluster: true
  /** Captured config after late failure or unavailable config before creation. */
  readonly clusterConfigSnapshot: Exclude<
    RunEvidenceClusterConfigSnapshot,
    RunEvidencePendingClusterConfigSnapshot
  >
  /** Immutable setup and terminal refs with no iterations. */
  readonly records: RunEvidenceCommittedRecordRefs & SetupFailedRecordOwnFields
  /** Setup failure occurs before OPP artifact collection. */
  readonly artifacts: readonly []
}

/** Record refs narrowed to the still-running shape. */
interface RunningRecordOwnFields {
  /** Terminal record has not committed while the ramp is running. */
  readonly terminal: null
}

/** Fields contributed by the active ramp lifecycle. */
interface RunningManifestOwnFields {
  /** Active ramp lifecycle. */
  readonly lifecycle: RunEvidenceLifecycle.Running
  /** Active runs preserve the cluster until a terminal decision. */
  readonly preserveCluster: true
  /** Committed setup and contiguous iterations without a terminal ref. */
  readonly records: RunEvidenceCommittedRecordRefs & RunningRecordOwnFields
}

/** Record refs narrowed to a committed terminal decision. */
interface TerminatedRecordOwnFields {
  /** Immutable committed terminal record ref. */
  readonly terminal: RunEvidenceTerminalRecordRef
}

/** Fields contributed by the failed terminal lifecycle. */
interface FailedManifestOwnFields {
  /** Failed terminal lifecycle, orthogonal to established saturation. */
  readonly lifecycle: RunEvidenceLifecycle.Failed
  /** Failed runs preserve the cluster for diagnosis. */
  readonly preserveCluster: true
  /** Immutable setup, iteration, and terminal refs. */
  readonly records: RunEvidenceCommittedRecordRefs & TerminatedRecordOwnFields
}

/** Fields contributed by the clean exact-max incomplete lifecycle. */
interface IncompleteManifestOwnFields {
  /** Clean exact-max lifecycle that did not saturate every endpoint. */
  readonly lifecycle: RunEvidenceLifecycle.Incomplete
  /** Incomplete runs preserve the cluster for diagnosis. */
  readonly preserveCluster: true
  /** Healthy aggregate telemetry required for a clean incomplete run. */
  readonly telemetry: HealthyOppEnvelopeTelemetryHealth
  /** Immutable setup, iteration, and terminal refs. */
  readonly records: RunEvidenceCommittedRecordRefs & TerminatedRecordOwnFields
}

/** Fields contributed by the all-endpoint saturation lifecycle. */
interface SaturatedManifestOwnFields {
  /** Successful all-endpoint saturation lifecycle. */
  readonly lifecycle: RunEvidenceLifecycle.Saturated
  /** Successful saturation permits cluster cleanup. */
  readonly preserveCluster: false
  /** Healthy aggregate telemetry required for saturation. */
  readonly telemetry: HealthyOppEnvelopeTelemetryHealth
  /** Immutable setup, iteration, and terminal refs. */
  readonly records: RunEvidenceCommittedRecordRefs & TerminatedRecordOwnFields
}

/** Schema-v1 run manifest with lifecycle-compatible snapshot and record states. */
export type RunEvidenceManifest =
  | (ManifestFields & InitializingManifestOwnFields)
  | (ManifestFields & SetupFailedManifestOwnFields)
  | (ActiveManifestFields & RunningManifestOwnFields)
  | (ActiveManifestFields & FailedManifestOwnFields)
  | (Omit<ActiveManifestFields, "telemetry"> & IncompleteManifestOwnFields)
  | (Omit<ActiveManifestFields, "telemetry"> & SaturatedManifestOwnFields)
