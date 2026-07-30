import type {
  OppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth
} from "./envelopeMetricTypes.js"
import type { RunEvidencePersistence } from "./runEvidencePersistence.js"
import type {
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidencePhase,
  RunEvidenceRampConfig
} from "./runEvidenceTypes.js"

/** Default OPP stress ramp constants for local e2e runs. */
export namespace OppStressRampDefaults {
  /** First account count in a stress ramp. */
  export const InitialCount = 8
  /** Account-count multiplier between non-saturating iterations. */
  export const Multiplier = 2
  /** Safety cap that bounds a stress campaign. */
  export const MaxCount = 512
  /** Per-phase timeout metadata persisted into evidence. */
  export const PhaseTimeoutMs = 480_000
}

/** Immutable OPP stress ramp configuration. */
export type OppStressRampConfig = RunEvidenceRampConfig

/** Input passed to the caller's OPP workload iteration runner. */
export interface OppStressRampIterationInput {
  /** Zero-based iteration index. */
  readonly iterationIndex: number
  /** Account or request count for this iteration. */
  readonly accountCount: number
  /** Per-phase timeout selected by the ramp config. */
  readonly phaseTimeoutMs: number
}

/** Observation fields carried onto a controller summary unchanged. */
export interface OppStressRampObservationSummaryFields {
  /** Workload phase that produced the observation. */
  readonly phase: string
  /** Workload observation start timestamp in Unix milliseconds. */
  readonly observationStartedAtMs: number | bigint
  /** Workload observation end timestamp in Unix milliseconds. */
  readonly observationEndedAtMs: number | bigint
  /** Successful transaction count across the measured phase. */
  readonly txSuccesses: number
  /** Failed transaction count across the measured phase. */
  readonly txFailures: number
  /** Matching OPP envelope count for the phase window. */
  readonly envelopeCount: number
  /** Matching OPP envelope byte sizes. */
  readonly envelopeByteSizes: readonly number[]
  /** Endpoint direction label retained in the in-memory summary. */
  readonly endpoint: string
  /** Inclusive epoch lower bound for the metrics window. */
  readonly epochStart: number
  /** Inclusive epoch upper bound for the metrics window. */
  readonly epochEnd: number
}

/** Observation endpoint accounting the controller re-derives per iteration. */
export interface OppStressRampObservationEndpointFields {
  /** Current required endpoints claimed saturated by this observation. */
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  /** Non-required endpoints retained only for flow diagnostics. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Todo13 compatibility fields retained in callback observations and results. */
export interface OppStressRampObservationFields
  extends OppStressRampObservationSummaryFields,
    OppStressRampObservationEndpointFields {}

/** Exact endpoint-specific telemetry supplied in allocation order. */
export interface OppStressRampEndpointTelemetry {
  /** Canonical required endpoint. */
  readonly endpoint: RunEvidenceEndpoint
  /** Callback-owned telemetry; the controller owns saturation. */
  readonly telemetry: OppEnvelopeTelemetryHealth
}

/** Complete schema-native evidence supplied by a persisted callback. */
export interface OppStressRampObservationEvidence {
  /** Complete phases with real baseline and immutable artifact references. */
  readonly phases: readonly RunEvidencePhase[]
  /** Exactly one telemetry value per required endpoint in allocation order. */
  readonly endpointTelemetry: readonly OppStressRampEndpointTelemetry[]
  /** Exact aggregate callback telemetry. */
  readonly telemetry: OppEnvelopeTelemetryHealth
}

/** Valid schema-v1 callback observation for a completed workload iteration. */
export interface OppStressRampCompletedObservation
  extends OppStressRampObservationFields,
    OppStressRampObservationEvidence {
  /** Completed callback discriminant. */
  readonly kind: "completed"
}

/** Valid schema-v1 callback observation for workload breakage. */
export interface OppStressRampBreakageObservation
  extends OppStressRampObservationFields,
    OppStressRampObservationEvidence {
  /** Breakage callback discriminant. */
  readonly kind: "breakage"
  /** Typed breakage classification. */
  readonly breakageCategory: RampBreakageCategory
  /** Non-empty explanation of the breakage. */
  readonly breakageReason: string
}

/** Exact rich runtime observation returned in schema-v1 mode. */
export type OppStressRampIterationObservation =
  OppStressRampCompletedObservation | OppStressRampBreakageObservation

/** Temporary Todo13 completed observation accepted only by deferred flow mode. */
export interface OppStressRampDeferredCompletedObservation
  extends OppStressRampObservationFields {
  /** Completed callback discriminant. */
  readonly kind: "completed"
}

/** Temporary Todo13 breakage accepted only by deferred flow mode. */
export interface OppStressRampDeferredBreakageObservation
  extends OppStressRampObservationFields {
  /** Breakage callback discriminant. */
  readonly kind: "breakage"
  /** Typed breakage classification. */
  readonly breakageCategory: RampBreakageCategory
  /** Non-empty explanation of the breakage. */
  readonly breakageReason: string
}

/** Temporary no-write callback union removed by the future flow migration. */
export type OppStressRampDeferredIterationObservation =
  | OppStressRampDeferredCompletedObservation
  | OppStressRampDeferredBreakageObservation

/** Explicit evidence ownership modes for the ramp controller. */
export enum OppStressRampEvidenceModeKind {
  SchemaV1 = "schema_v1",
  DeferredFlowMigration = "deferred_flow_migration"
}

/** Closed final statuses of an OPP stress campaign. */
export enum OppStressRampResultStatusKind {
  saturated = "saturated",
  partial_saturation = "partial_saturation",
  failed_before_saturation = "failed_before_saturation",
  saturation_not_reached = "saturation_not_reached"
}

/** Final OPP stress campaign status. */
export type OppStressRampResultStatus = `${OppStressRampResultStatusKind}`

/** Per-iteration status: a campaign status or the not-saturated outcome. */
export type OppStressRampEvidenceStatus =
  | OppStressRampResultStatus
  | `${RunEvidenceIterationOutcome.NotSaturated}`

/** Non-breakage iteration outcomes recorded on a controller summary. */
type SettledIterationOutcome = Exclude<
  `${RunEvidenceIterationOutcome}`,
  `${RunEvidenceIterationOutcome.Breakage}`
>

interface OppStressRampEvidenceFields {
  readonly iterationIndex: number
  readonly accountCount: number
  readonly startedAtMs: number
  readonly endedAtMs: number
  readonly status: OppStressRampEvidenceStatus
  readonly preserveCluster: boolean
  readonly config: OppStressRampConfig
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Controller summary fields shared by every callback-backed outcome. */
interface ObservationBackedEvidenceFields
  extends OppStressRampEvidenceFields,
    OppStressRampObservationSummaryFields {
  readonly observation: OppStressRampObservationFields
}

/** Callback-backed summary for an iteration that settled without breakage. */
interface OppStressRampSettledObservationEvidence
  extends ObservationBackedEvidenceFields {
  readonly kind: SettledIterationOutcome
}

/** Callback-backed summary for an iteration that broke. */
interface OppStressRampBrokenObservationEvidence
  extends ObservationBackedEvidenceFields {
  readonly kind: "breakage"
  readonly breakageCategory: RampBreakageCategory
  readonly breakageReason: string
}

/** Summary backed by a successfully parsed callback observation. */
export type OppStressRampObservationBackedEvidence =
  | OppStressRampSettledObservationEvidence
  | OppStressRampBrokenObservationEvidence

/** Truthful controller failure summary when no callback observation exists. */
export interface OppStressRampBoundaryFailureEvidence
  extends OppStressRampEvidenceFields {
  readonly kind: "breakage"
  readonly observation: null
  readonly breakageCategory: RampBreakageCategory
  readonly breakageReason: string
  readonly telemetry: OppEnvelopeTelemetryHealth
  readonly cause: unknown
}

/** Honest callback-backed or no-observation controller evidence union. */
export type OppStressRampEvidence =
  OppStressRampObservationBackedEvidence | OppStressRampBoundaryFailureEvidence

/** Final ramp result returned to an e2e flow. */
export interface OppStressRampResult {
  readonly status: OppStressRampResultStatus
  readonly preserveCluster: boolean
  readonly iterations: readonly OppStressRampEvidence[]
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
}

interface CommonRampOptions {
  /** Controller lifecycle clock, defaulting to Date.now. */
  readonly clock?: () => number
}

/** Options for real atomic schema-v1 persistence. */
export interface OppStressRampSchemaV1Options extends CommonRampOptions {
  /** Active persistence is the sole allocation and publication authority. */
  readonly evidenceMode: OppStressRampEvidenceModeKind.SchemaV1
  /** Active run that owns allocation identity and every atomic publication. */
  readonly persistence: RunEvidencePersistence
  /** Real iteration callback returning complete schema-native evidence. */
  readonly runIteration: (
    input: OppStressRampIterationInput
  ) => Promise<OppStressRampIterationObservation>
}

/** Temporary flow-only no-write options retained until production migration. */
export interface OppStressRampDeferredOptions extends CommonRampOptions {
  /** Explicitly disables all evidence filesystem writes. */
  readonly evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration
  /** Required canonical endpoint order supplied by the legacy flow. */
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  /** Temporary flow ramp config. */
  readonly config?: OppStressRampConfig
  /** Generic evidence parsing belongs exclusively to the typed deferred overload. */
  readonly parseEvidence?: never
  /** Todo13 callback returning compatibility-only observations. */
  readonly runIteration: (
    input: OppStressRampIterationInput
  ) => Promise<OppStressRampDeferredIterationObservation>
}

/** Discriminated schema-v1 or temporary no-write controller options. */
export type OppStressRampOptions =
  OppStressRampSchemaV1Options | OppStressRampDeferredOptions

/** Healthy endpoint telemetry retained after cumulative saturation. */
export type OppStressRampHealthyEndpointTelemetry = ReadonlyMap<
  RunEvidenceEndpoint,
  HealthyOppEnvelopeTelemetryHealth
>
