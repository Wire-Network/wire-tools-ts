import type {
  OppStressRampConfig,
  OppStressRampIterationInput,
  OppStressRampResultStatus
} from "./rampControllerTypes.js"
import { OppStressRampEvidenceModeKind } from "./rampControllerTypes.js"
import type {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "./runEvidenceTypes.js"
import type { OppEnvelopeTelemetryHealth } from "./envelopeMetricTypes.js"

/** Completed generic deferred observation with one flow-owned evidence payload. */
export type OppStressRampDeferredEvidenceCompletedObservation<
  TEvidence extends object
> = {
  readonly kind: "completed"
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
  readonly evidence: TEvidence
}

/** Breakage generic deferred observation with one flow-owned evidence payload. */
export type OppStressRampDeferredEvidenceBreakageObservation<
  TEvidence extends object
> = {
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

/** Canonical root facts supplied to a flow-owned evidence parser. */
export type OppStressRampDeferredEvidenceParseContext = {
  /** Parsed root saturation claims in canonical required-endpoint order. */
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
} & (
  | { readonly kind: "completed" }
  | {
      readonly kind: "breakage"
      readonly breakageCategory: RampBreakageCategory
    }
)

/** Parser for one recursively snapshotted flow evidence payload. */
export type OppStressRampDeferredEvidenceParser<TEvidence extends object> = (
  input: unknown,
  context: OppStressRampDeferredEvidenceParseContext
) => TEvidence | null

/** Explicit no-write options for generic callback evidence transport. */
export type OppStressRampDeferredEvidenceOptions<TEvidence extends object> = {
  readonly evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly config?: OppStressRampConfig
  readonly clock?: () => number
  readonly parseEvidence: OppStressRampDeferredEvidenceParser<TEvidence>
  readonly runIteration: (
    input: OppStressRampIterationInput
  ) => Promise<OppStressRampDeferredEvidenceIterationObservation<TEvidence>>
}

type DeferredEvidenceSummaryFields = {
  readonly iterationIndex: number
  readonly accountCount: number
  readonly startedAtMs: number
  readonly endedAtMs: number
  readonly status: OppStressRampResultStatus | "not_saturated"
  readonly preserveCluster: boolean
  readonly config: OppStressRampConfig
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Controller summary backed by a successfully parsed generic observation. */
export type OppStressRampDeferredEvidenceObservationBackedSummary<
  TEvidence extends object
> = DeferredEvidenceSummaryFields &
  (
    | {
        readonly kind: "not_saturated" | "saturated"
        readonly observation: OppStressRampDeferredEvidenceCompletedObservation<TEvidence>
      }
    | {
        readonly kind: "breakage"
        readonly observation: OppStressRampDeferredEvidenceBreakageObservation<TEvidence>
        readonly breakageCategory: RampBreakageCategory
        readonly breakageReason: string
      }
  )

/** Controller boundary failure produced before a generic observation exists. */
export type OppStressRampDeferredEvidenceBoundaryFailureSummary =
  DeferredEvidenceSummaryFields & {
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
export type OppStressRampDeferredEvidenceResult<TEvidence extends object> = {
  readonly status: OppStressRampResultStatus
  readonly preserveCluster: boolean
  readonly iterations: readonly OppStressRampDeferredEvidenceSummary<TEvidence>[]
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly observedNonRequiredEndpoints: readonly string[]
}
