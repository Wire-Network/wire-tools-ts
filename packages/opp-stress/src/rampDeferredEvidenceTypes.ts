import type {
  OppStressRampConfig,
  OppStressRampEvidenceStatus,
  OppStressRampIterationInput,
  OppStressRampResultStatus
} from "./rampControllerTypes.js"
import { OppStressRampEvidenceModeKind } from "./rampControllerTypes.js"
import type {
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome
} from "./runEvidenceTypes.js"
import type { OppEnvelopeTelemetryHealth } from "./envelopeMetricTypes.js"

/** Completed generic deferred observation with one flow-owned evidence payload. */
export interface OppStressRampDeferredEvidenceCompletedObservation<
  TEvidence extends object
> {
  readonly kind: "completed"
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
  readonly evidence: TEvidence
}

/** Breakage generic deferred observation with one flow-owned evidence payload. */
export interface OppStressRampDeferredEvidenceBreakageObservation<
  TEvidence extends object
> {
  readonly kind: "breakage"
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
  readonly breakageCategory: RampBreakageCategory
  readonly breakageReason: string
  readonly evidence: TEvidence
}

/** Exact callback observation union for generic deferred mode. */
export type OppStressRampDeferredEvidenceIterationObservation<
  TEvidence extends object
> =
  | OppStressRampDeferredEvidenceCompletedObservation<TEvidence>
  | OppStressRampDeferredEvidenceBreakageObservation<TEvidence>

/** Root facts every flow-owned evidence parser receives. */
interface DeferredEvidenceParseContextFields {
  /** Parsed root saturation claims in canonical required-endpoint order. */
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
}

/** Parser context for a completed generic deferred observation. */
interface CompletedDeferredEvidenceParseContext
  extends DeferredEvidenceParseContextFields {
  readonly kind: "completed"
}

/** Parser context for a breakage generic deferred observation. */
interface BreakageDeferredEvidenceParseContext
  extends DeferredEvidenceParseContextFields {
  readonly kind: "breakage"
  readonly breakageCategory: RampBreakageCategory
}

/** Canonical root facts supplied to a flow-owned evidence parser. */
export type OppStressRampDeferredEvidenceParseContext =
  | CompletedDeferredEvidenceParseContext
  | BreakageDeferredEvidenceParseContext

/** Parser for one recursively snapshotted flow evidence payload. */
export type OppStressRampDeferredEvidenceParser<TEvidence extends object> = (
  input: unknown,
  context: OppStressRampDeferredEvidenceParseContext
) => TEvidence | null

/** Explicit no-write options for generic callback evidence transport. */
export interface OppStressRampDeferredEvidenceOptions<
  TEvidence extends object
> {
  readonly evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly config?: OppStressRampConfig
  readonly clock?: () => number
  readonly parseEvidence: OppStressRampDeferredEvidenceParser<TEvidence>
  readonly runIteration: (
    input: OppStressRampIterationInput
  ) => Promise<OppStressRampDeferredEvidenceIterationObservation<TEvidence>>
}

/** Controller-owned identity and decision fields on every deferred summary. */
export interface DeferredEvidenceSummaryFields {
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

/** Non-breakage iteration outcomes recorded on a generic deferred summary. */
type SettledIterationOutcome = Exclude<
  `${RunEvidenceIterationOutcome}`,
  `${RunEvidenceIterationOutcome.Breakage}`
>

/** Generic deferred summary for an iteration that settled without breakage. */
interface OppStressRampDeferredEvidenceSettledSummary<
  TEvidence extends object
> extends DeferredEvidenceSummaryFields {
  readonly kind: SettledIterationOutcome
  readonly observation: OppStressRampDeferredEvidenceCompletedObservation<TEvidence>
}

/** Generic deferred summary for an iteration that broke. */
interface OppStressRampDeferredEvidenceBrokenSummary<TEvidence extends object>
  extends DeferredEvidenceSummaryFields {
  readonly kind: "breakage"
  readonly observation: OppStressRampDeferredEvidenceBreakageObservation<TEvidence>
  readonly breakageCategory: RampBreakageCategory
  readonly breakageReason: string
}

/** Controller summary backed by a successfully parsed generic observation. */
export type OppStressRampDeferredEvidenceObservationBackedSummary<
  TEvidence extends object
> =
  | OppStressRampDeferredEvidenceSettledSummary<TEvidence>
  | OppStressRampDeferredEvidenceBrokenSummary<TEvidence>

/** Controller boundary failure produced before a generic observation exists. */
export interface OppStressRampDeferredEvidenceBoundaryFailureSummary
  extends DeferredEvidenceSummaryFields {
  readonly kind: "breakage"
  readonly observation: null
  readonly breakageCategory: RampBreakageCategory
  readonly breakageReason: string
  readonly telemetry: OppEnvelopeTelemetryHealth
  readonly cause: unknown
}

/** Callback-backed or truthful no-observation generic iteration summary. */
export type OppStressRampDeferredEvidenceSummary<TEvidence extends object> =
  | OppStressRampDeferredEvidenceObservationBackedSummary<TEvidence>
  | OppStressRampDeferredEvidenceBoundaryFailureSummary

/** Final generic deferred ramp result with typed callback evidence. */
export interface OppStressRampDeferredEvidenceResult<
  TEvidence extends object
> {
  readonly status: OppStressRampResultStatus
  readonly preserveCluster: boolean
  readonly iterations: readonly OppStressRampDeferredEvidenceSummary<TEvidence>[]
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
}
