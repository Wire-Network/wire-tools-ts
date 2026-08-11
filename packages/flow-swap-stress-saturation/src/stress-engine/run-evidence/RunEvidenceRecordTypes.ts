import type { EnvelopeBaseline, EnvelopeBaselineIdentity } from "../../envelope-integrity/index.js"

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

interface BreakageFields {
  /** Typed category used to route and independently verify the breakage. */
  readonly breakageCategory: RampBreakageCategory
  /** Stable human-readable explanation retained with the typed category. */
  readonly breakageReason: string
}

interface EndpointSetFields {
  /** Non-empty unique endpoints required for this controller decision. */
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  /** Required endpoints independently classified as saturated. */
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  /** Required endpoints not independently classified as saturated. */
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
}

interface EndpointDecisionFields extends EndpointSetFields {
  /** One telemetry-backed result for every required endpoint. */
  readonly endpointResults: readonly RunEvidenceEndpointResult[]
  /** Aggregate telemetry health for the controller decision. */
  readonly telemetry: OppEnvelopeTelemetryHealth
}

interface HealthyEndpointDecisionFields extends EndpointSetFields {
  /** One healthy telemetry-backed result for every required endpoint. */
  readonly endpointResults: readonly RunEvidenceHealthyEndpointResult[]
  /** Healthy aggregate telemetry for a clean completed decision. */
  readonly telemetry: HealthyOppEnvelopeTelemetryHealth
}

interface SetupFields {
  /** Clean schema version. */
  readonly schemaVersion: RunEvidenceVersion
  /** Standalone setup-stage discriminant. */
  readonly stage: RunEvidenceStage.Setup
  /** Controller timestamp immediately before setup starts. */
  readonly startedAtMs: RunEvidenceDecimal
  /** Controller timestamp immediately after setup resolves. */
  readonly endedAtMs: RunEvidenceDecimal
}

/** Setup record for a run whose cluster configuration was created. */
export interface RunEvidenceSucceededSetup extends SetupFields {
  /** Successful setup outcome. */
  readonly status: RunEvidenceSetupStatus.Succeeded
  /** Confirms setup produced a cluster configuration snapshot. */
  readonly clusterConfigCreated: true
}

/** Setup record for a run that broke before or during cluster creation. */
export interface RunEvidenceFailedSetup extends SetupFields, BreakageFields {
  /** Failed setup outcome. */
  readonly status: RunEvidenceSetupStatus.Failed
  /** Whether configuration committed before the setup failure. */
  readonly clusterConfigCreated: boolean
}

/** Standalone setup lifecycle record; setup is never iteration zero. */
export type RunEvidenceSetup = RunEvidenceSucceededSetup | RunEvidenceFailedSetup

/** Per-endpoint telemetry and saturation comparison target. */
export interface RunEvidenceEndpointResult {
  /** Canonical endpoint represented by this result. */
  readonly endpoint: RunEvidenceEndpoint
  /** Endpoint-specific telemetry observation. */
  readonly telemetry: OppEnvelopeTelemetryHealth
  /** Recorded endpoint saturation decision. */
  readonly saturated: boolean
}

/** Per-endpoint result legal on a clean completed decision. */
export interface RunEvidenceHealthyEndpointResult {
  /** Canonical endpoint represented by this result. */
  readonly endpoint: RunEvidenceEndpoint
  /** Healthy endpoint-specific telemetry observation. */
  readonly telemetry: HealthyOppEnvelopeTelemetryHealth
  /** Recorded endpoint saturation decision. */
  readonly saturated: boolean
}

/** Identity of the all-key baseline captured before phase submission. */
export interface RunEvidencePhaseBaseline {
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

/** Recorded phase values compared with independently recomputed metrics. */
export interface RunEvidencePhaseMetrics {
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

interface PhaseIdentityFields {
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
  /** Recorded metric and workload comparison targets. */
  readonly metrics: RunEvidencePhaseMetrics
}

interface PhaseFields extends PhaseIdentityFields {
  /** Phase telemetry health and structured issues. */
  readonly telemetry: OppEnvelopeTelemetryHealth
}

/** Clean completed evidence for one workload phase. */
export interface RunEvidenceCompletedPhase extends PhaseIdentityFields {
  /** Clean completed phase outcome. */
  readonly status: RunEvidencePhaseStatus.Completed
  /** Healthy telemetry required for a clean completed phase. */
  readonly telemetry: HealthyOppEnvelopeTelemetryHealth
}

/** Typed breakage evidence for one workload phase. */
export interface RunEvidenceBreakagePhase
  extends PhaseFields,
    BreakageFields {
  /** Typed breakage phase outcome. */
  readonly status: RunEvidencePhaseStatus.Breakage
}

/** Recomputable completed-or-breakage evidence for one workload phase. */
export type RunEvidencePhase =
  RunEvidenceCompletedPhase | RunEvidenceBreakagePhase

interface IterationFields {
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

/** Iteration record for a controller decision that settled without breakage. */
export interface RunEvidenceSettledIteration
  extends IterationFields,
    HealthyEndpointDecisionFields {
  /** Clean completed controller outcome. */
  readonly outcome:
    | RunEvidenceIterationOutcome.NotSaturated
    | RunEvidenceIterationOutcome.Saturated
}

/** Iteration record for a controller decision that broke. */
export interface RunEvidenceBrokenIteration
  extends IterationFields,
    EndpointDecisionFields,
    BreakageFields {
  /** Typed controller breakage outcome. */
  readonly outcome: RunEvidenceIterationOutcome.Breakage
}

/** Schema-v1 completed-or-breakage record for one non-setup ramp iteration. */
export type RunEvidenceIteration =
  RunEvidenceSettledIteration | RunEvidenceBrokenIteration

interface TerminalFields {
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

/** Terminal decision after every required endpoint saturated. */
export interface RunEvidenceSaturatedTerminal
  extends TerminalFields,
    HealthyEndpointDecisionFields {
  /** Successful all-endpoint saturation lifecycle. */
  readonly lifecycle: RunEvidenceLifecycle.Saturated
  /** Successful saturation permits cluster cleanup. */
  readonly preserveCluster: false
}

/** Terminal decision after a clean run that did not saturate every endpoint. */
export interface RunEvidenceIncompleteTerminal
  extends TerminalFields,
    HealthyEndpointDecisionFields {
  /** Clean exact-max outcome that did not saturate every endpoint. */
  readonly lifecycle: RunEvidenceLifecycle.Incomplete
  /** Incomplete runs preserve the cluster for diagnosis. */
  readonly preserveCluster: true
}

/** Terminal decision after setup or iteration breakage. */
export interface RunEvidenceFailedTerminal
  extends TerminalFields,
    EndpointDecisionFields,
    BreakageFields {
  /** Setup or iteration breakage, orthogonal to established saturation. */
  readonly lifecycle:
    | RunEvidenceLifecycle.SetupFailed
    | RunEvidenceLifecycle.Failed
  /** Failed runs preserve the cluster even when every endpoint saturated. */
  readonly preserveCluster: true
}

/** Schema-v1 controller terminal decision with variant-specific breakage data. */
export type RunEvidenceTerminal =
  | RunEvidenceSaturatedTerminal
  | RunEvidenceIncompleteTerminal
  | RunEvidenceFailedTerminal
