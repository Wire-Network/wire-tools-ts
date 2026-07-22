import type {
  HealthyOppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryHealth
} from "../envelopeMetricTypes.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceClusterConfigSnapshot,
  RunEvidenceCommittedRecordRefs,
  RunEvidenceDecimal,
  RunEvidenceInitializingRecordRefs,
  RunEvidenceProvenance,
  RunEvidenceRampConfig,
  RunEvidenceRuntime,
  RunEvidenceTerminalRecordRef,
  RunEvidenceVersion
} from "./RunEvidenceCoreTypes.js"
import type {
  RunEvidenceClusterConfigState,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle
} from "./runEvidenceConstants.js"

type ManifestFields = {
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

type ActiveManifestFields = Omit<ManifestFields, "telemetry"> & {
  /** Immutable captured cluster configuration. */
  readonly clusterConfigSnapshot: Extract<
    RunEvidenceClusterConfigSnapshot,
    { readonly kind: RunEvidenceClusterConfigState.Captured }
  >
  /** Immutable OPP artifacts accepted by the run. */
  readonly artifacts: readonly RunEvidenceArtifact[]
  /** Aggregate telemetry health at this checkpoint. */
  readonly telemetry: OppEnvelopeTelemetryHealth
}

/** Schema-v1 run manifest with lifecycle-compatible snapshot and record states. */
export type RunEvidenceManifest =
  | (ManifestFields & {
      /** Pre-setup allocation lifecycle. */
      readonly lifecycle: RunEvidenceLifecycle.Initializing
      /** Initial allocation is retained until setup resolves. */
      readonly preserveCluster: true
      /** Cluster configuration has not been created. */
      readonly clusterConfigSnapshot: {
        /** Pending configuration state. */
        readonly kind: RunEvidenceClusterConfigState.Pending
      }
      /** Explicit pending setup with no committed iteration or terminal refs. */
      readonly records: RunEvidenceInitializingRecordRefs
      /** No immutable OPP artifacts exist before setup. */
      readonly artifacts: readonly []
    })
  | (ManifestFields & {
      /** Setup breakage lifecycle. */
      readonly lifecycle: RunEvidenceLifecycle.SetupFailed
      /** Setup failures preserve the cluster and evidence. */
      readonly preserveCluster: true
      /** Captured config after late failure or unavailable config before creation. */
      readonly clusterConfigSnapshot: Exclude<
        RunEvidenceClusterConfigSnapshot,
        { readonly kind: RunEvidenceClusterConfigState.Pending }
      >
      /** Immutable setup and terminal refs with no iterations. */
      readonly records: RunEvidenceCommittedRecordRefs & {
        /** Setup fails before any ramp iteration commits. */
        readonly iterations: readonly []
        /** Immutable setup-failure terminal record ref. */
        readonly terminal: RunEvidenceTerminalRecordRef
      }
      /** Setup failure occurs before OPP artifact collection. */
      readonly artifacts: readonly []
    })
  | (ActiveManifestFields & {
      /** Active ramp lifecycle. */
      readonly lifecycle: RunEvidenceLifecycle.Running
      /** Active runs preserve the cluster until a terminal decision. */
      readonly preserveCluster: true
      /** Committed setup and contiguous iterations without a terminal ref. */
      readonly records: RunEvidenceCommittedRecordRefs & {
        /** Terminal record has not committed while the ramp is running. */
        readonly terminal: null
      }
    })
  | (ActiveManifestFields & {
      /** Failed terminal lifecycle, orthogonal to established saturation. */
      readonly lifecycle: RunEvidenceLifecycle.Failed
      /** Failed runs preserve the cluster for diagnosis. */
      readonly preserveCluster: true
      /** Immutable setup, iteration, and terminal refs. */
      readonly records: RunEvidenceCommittedRecordRefs & {
        /** Immutable committed terminal record ref. */
        readonly terminal: RunEvidenceTerminalRecordRef
      }
    })
  | (Omit<ActiveManifestFields, "telemetry"> & {
      /** Clean exact-max lifecycle that did not saturate every endpoint. */
      readonly lifecycle: RunEvidenceLifecycle.Incomplete
      /** Incomplete runs preserve the cluster for diagnosis. */
      readonly preserveCluster: true
      /** Healthy aggregate telemetry required for a clean incomplete run. */
      readonly telemetry: HealthyOppEnvelopeTelemetryHealth
      /** Immutable setup, iteration, and terminal refs. */
      readonly records: RunEvidenceCommittedRecordRefs & {
        /** Immutable committed terminal record ref. */
        readonly terminal: RunEvidenceTerminalRecordRef
      }
    })
  | (Omit<ActiveManifestFields, "telemetry"> & {
      /** Successful all-endpoint saturation lifecycle. */
      readonly lifecycle: RunEvidenceLifecycle.Saturated
      /** Successful saturation permits cluster cleanup. */
      readonly preserveCluster: false
      /** Healthy aggregate telemetry required for saturation. */
      readonly telemetry: HealthyOppEnvelopeTelemetryHealth
      /** Immutable setup, iteration, and terminal refs. */
      readonly records: RunEvidenceCommittedRecordRefs & {
        /** Immutable committed terminal record ref. */
        readonly terminal: RunEvidenceTerminalRecordRef
      }
    })
