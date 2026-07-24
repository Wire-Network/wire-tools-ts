import type {
  EnvelopeBaseline,
  EnvelopeBaselineIdentity
} from "@wireio/debugging-shared"

import type {
  HealthyOppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryHealth
} from "../envelopeMetricTypes.js"
import type {
  RunEvidenceDecimal,
  RunEvidenceIterationRecordRef,
  RunEvidenceVersion
} from "./RunEvidenceCoreTypes.js"
import type {
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePhaseStatus,
  RunEvidenceSaturationStrategy,
  RunEvidenceSetupStatus,
  RunEvidenceStage
} from "./runEvidenceConstants.js"

type BreakageFields = {
  /** Typed category used to route and independently verify the breakage. */
  readonly breakageCategory: RampBreakageCategory
  /** Stable human-readable explanation retained with the typed category. */
  readonly breakageReason: string
}

type EndpointDecisionFields = {
  /** Non-empty unique endpoints required for this controller decision. */
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  /** Required endpoints independently classified as saturated. */
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  /** Required endpoints not independently classified as saturated. */
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  /** One telemetry-backed result for every required endpoint. */
  readonly endpointResults: readonly RunEvidenceEndpointResult[]
  /** Aggregate telemetry health for the controller decision. */
  readonly telemetry: OppEnvelopeTelemetryHealth
}

type HealthyEndpointDecisionFields = Omit<
  EndpointDecisionFields,
  "endpointResults" | "telemetry"
> & {
  /** One healthy telemetry-backed result for every required endpoint. */
  readonly endpointResults: readonly RunEvidenceHealthyEndpointResult[]
  /** Healthy aggregate telemetry for a clean completed decision. */
  readonly telemetry: HealthyOppEnvelopeTelemetryHealth
}

/** Standalone setup lifecycle record; setup is never iteration zero. */
export type RunEvidenceSetup =
  | {
      /** Clean schema version. */
      readonly schemaVersion: RunEvidenceVersion
      /** Standalone setup-stage discriminant. */
      readonly stage: RunEvidenceStage.Setup
      /** Successful setup outcome. */
      readonly status: RunEvidenceSetupStatus.Succeeded
      /** Controller timestamp immediately before setup starts. */
      readonly startedAtMs: RunEvidenceDecimal
      /** Controller timestamp immediately after setup succeeds. */
      readonly endedAtMs: RunEvidenceDecimal
      /** Confirms setup produced a cluster configuration snapshot. */
      readonly clusterConfigCreated: true
    }
  | ({
      /** Clean schema version. */
      readonly schemaVersion: RunEvidenceVersion
      /** Standalone setup-stage discriminant. */
      readonly stage: RunEvidenceStage.Setup
      /** Failed setup outcome. */
      readonly status: RunEvidenceSetupStatus.Failed
      /** Controller timestamp immediately before setup starts. */
      readonly startedAtMs: RunEvidenceDecimal
      /** Controller timestamp immediately after setup fails. */
      readonly endedAtMs: RunEvidenceDecimal
      /** Whether configuration committed before the setup failure. */
      readonly clusterConfigCreated: boolean
    } & BreakageFields)

/** Per-endpoint telemetry and saturation comparison target. */
export type RunEvidenceEndpointResult = {
  /** Canonical endpoint represented by this result. */
  readonly endpoint: RunEvidenceEndpoint
  /** Endpoint-specific telemetry observation. */
  readonly telemetry: OppEnvelopeTelemetryHealth
  /** Recorded endpoint saturation decision. */
  readonly saturated: boolean
}

/** Per-endpoint result legal on a clean completed decision. */
export type RunEvidenceHealthyEndpointResult = {
  /** Canonical endpoint represented by this result. */
  readonly endpoint: RunEvidenceEndpoint
  /** Healthy endpoint-specific telemetry observation. */
  readonly telemetry: HealthyOppEnvelopeTelemetryHealth
  /** Recorded endpoint saturation decision. */
  readonly saturated: boolean
}

/** Identity of the all-key baseline captured before phase submission. */
export type RunEvidencePhaseBaseline = {
  /** Stable identity linking every observation to the same baseline. */
  readonly identity: EnvelopeBaselineIdentity
  /** Canonically sorted all-key membership captured before phase submission. */
  readonly baseKeys: EnvelopeBaseline["baseKeys"]
  /** Monotonic observation ordinal allocated before collection. */
  readonly observationOrdinal: RunEvidenceDecimal
  /** Artifact refs already present when the phase baseline was captured. */
  readonly artifactRefs: readonly string[]
}

/** Observation bounds used to independently select a phase's artifacts. */
export type RunEvidencePhaseWindow = {
  /** Inclusive observational timestamp lower bound. */
  readonly startedAtMs: RunEvidenceDecimal
  /** Inclusive observational timestamp upper bound. */
  readonly endedAtMs: RunEvidenceDecimal
  /** Inclusive source epoch lower bound. */
  readonly epochStart: RunEvidenceDecimal
  /** Inclusive source epoch upper bound. */
  readonly epochEnd: RunEvidenceDecimal
}

/** Recorded phase values compared with independently recomputed metrics. */
export type RunEvidencePhaseMetrics = {
  /** Successful workload transactions recorded for the phase. */
  readonly txSuccesses: number
  /** Failed workload transactions recorded for the phase. */
  readonly txFailures: number
  /** Valid matching envelope count recorded for comparison. */
  readonly envelopeCount: number
  /** Raw byte sizes for every recorded matching envelope. */
  readonly envelopeByteSizes: readonly number[]
  /** Epoch-envelope indexes for every recorded matching envelope. */
  readonly epochEnvelopeIndexes: readonly number[]
  /** Whether any Solana envelope exceeded its raw transaction cap. */
  readonly solanaOversized: boolean
  /** Recorded phase saturation classification. */
  readonly saturated: boolean
}

type PhaseFields = {
  /** Unique phase label within the iteration. */
  readonly label: string
  /** Canonical endpoint observed by the phase. */
  readonly endpoint: RunEvidenceEndpoint
  /** Strategy used to independently recompute saturation. */
  readonly strategy: RunEvidenceSaturationStrategy
  /** Pre-submission all-key observation baseline. */
  readonly baseline: RunEvidencePhaseBaseline
  /** Observation time and epoch bounds. */
  readonly window: RunEvidencePhaseWindow
  /** Immutable artifact refs used by this phase. */
  readonly artifactRefs: readonly string[]
  /** Phase telemetry health and structured issues. */
  readonly telemetry: OppEnvelopeTelemetryHealth
  /** Recorded metric and workload comparison targets. */
  readonly metrics: RunEvidencePhaseMetrics
}

/** Recomputable completed-or-breakage evidence for one workload phase. */
export type RunEvidencePhase =
  | (Omit<PhaseFields, "telemetry"> & {
      /** Clean completed phase outcome. */
      readonly status: RunEvidencePhaseStatus.Completed
      /** Healthy telemetry required for a clean completed phase. */
      readonly telemetry: HealthyOppEnvelopeTelemetryHealth
    })
  | (PhaseFields & {
      /** Typed breakage phase outcome. */
      readonly status: RunEvidencePhaseStatus.Breakage
    } & BreakageFields)

type IterationFields = {
  /** Clean schema version. */
  readonly schemaVersion: RunEvidenceVersion
  /** Iteration-stage discriminant. */
  readonly stage: RunEvidenceStage.Iteration
  /** Zero-based controller-owned iteration index. */
  readonly iterationIndex: number
  /** Controller-owned workload account count. */
  readonly accountCount: number
  /** Controller timestamp immediately before iteration callback invocation. */
  readonly startedAtMs: RunEvidenceDecimal
  /** Controller timestamp immediately after callback resolution or rejection. */
  readonly endedAtMs: RunEvidenceDecimal
  /** Recomputable phase observations for the iteration. */
  readonly phases: readonly RunEvidencePhase[]
}

/** Schema-v1 completed-or-breakage record for one non-setup ramp iteration. */
export type RunEvidenceIteration =
  | (IterationFields &
      HealthyEndpointDecisionFields & {
        /** Clean completed controller outcome. */
        readonly outcome:
          | RunEvidenceIterationOutcome.NotSaturated
          | RunEvidenceIterationOutcome.Saturated
      })
  | (IterationFields &
      EndpointDecisionFields & {
        /** Typed controller breakage outcome. */
        readonly outcome: RunEvidenceIterationOutcome.Breakage
      } & BreakageFields)

type TerminalFields = {
  /** Clean schema version. */
  readonly schemaVersion: RunEvidenceVersion
  /** Terminal-stage discriminant. */
  readonly stage: RunEvidenceStage.Terminal
  /** Controller timestamp at run allocation. */
  readonly startedAtMs: RunEvidenceDecimal
  /** Controller timestamp at terminal decision. */
  readonly endedAtMs: RunEvidenceDecimal
  /** Contiguous immutable iteration refs included by the terminal decision. */
  readonly iterationRefs: readonly RunEvidenceIterationRecordRef[]
}

/** Schema-v1 controller terminal decision with variant-specific breakage data. */
export type RunEvidenceTerminal =
  | (TerminalFields &
      HealthyEndpointDecisionFields & {
        /** Successful all-endpoint saturation lifecycle. */
        readonly lifecycle: RunEvidenceLifecycle.Saturated
        /** Successful saturation permits cluster cleanup. */
        readonly preserveCluster: false
      })
  | (TerminalFields &
      HealthyEndpointDecisionFields & {
        /** Clean exact-max outcome that did not saturate every endpoint. */
        readonly lifecycle: RunEvidenceLifecycle.Incomplete
        /** Incomplete runs preserve the cluster for diagnosis. */
        readonly preserveCluster: true
      })
  | (TerminalFields &
      EndpointDecisionFields & {
        /** Setup or iteration breakage, orthogonal to established saturation. */
        readonly lifecycle:
          RunEvidenceLifecycle.SetupFailed | RunEvidenceLifecycle.Failed
        /** Failed runs preserve the cluster even when every endpoint saturated. */
        readonly preserveCluster: true
      } & BreakageFields)
