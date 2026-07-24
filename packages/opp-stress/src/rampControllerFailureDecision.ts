import {
  OppEnvelopeTelemetryHealthKind,
  type DegradedOppEnvelopeTelemetryHealth,
  type EmptyOppEnvelopeTelemetryHealth,
  type OppEnvelopeTelemetryHealth
} from "./envelopeMetricTypes.js"
import type { CanonicalRampDecision } from "./rampDecision.js"
import type { OppStressRampHealthyEndpointTelemetry } from "./rampControllerTypes.js"
import { OppStressRampInvalidObservationError } from "./rampObservation.js"
import { requirePersistenceDecimal } from "./run-evidence/runEvidencePersistenceValidation.js"
import {
  RampBreakageCategory,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  type RunEvidenceEndpoint
} from "./runEvidenceTypes.js"

const EmptyTelemetry: EmptyOppEnvelopeTelemetryHealth = Object.freeze({
  kind: OppEnvelopeTelemetryHealthKind.Empty,
  retryable: true,
  candidateCount: 0,
  validCount: 0,
  filteredCount: 0,
  issueCount: 0,
  issues: Object.freeze([])
})

type ControllerFailureClassification =
  | {
      readonly category: RampBreakageCategory.TelemetryIntegrity
      readonly telemetry: DegradedOppEnvelopeTelemetryHealth
    }
  | {
      readonly category:
        | RampBreakageCategory.Infrastructure
        | RampBreakageCategory.InvalidObservation
      readonly telemetry: null
    }

/** Inputs for a truthful no-observation controller failure decision. */
export type RampControllerFailureDecisionInput =
  ControllerFailureClassification & {
    readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
    readonly priorSaturatedEndpoints: readonly RunEvidenceEndpoint[]
    readonly priorHealthyTelemetry: OppStressRampHealthyEndpointTelemetry
    readonly controllerStartedAtMs: number
    readonly controllerEndedAtMs: number
    readonly reason: string
    readonly cause: unknown
  }

/** Build the canonical failed decision for a callback-boundary failure. */
export function decideRampControllerFailure(
  input: RampControllerFailureDecisionInput
): Extract<CanonicalRampDecision, { readonly kind: "failed" }> {
  const saturatedEndpoints = input.requiredEndpoints.filter(endpoint =>
      input.priorSaturatedEndpoints.includes(endpoint)
    ),
    missingEndpoints = input.requiredEndpoints.filter(
      endpoint => !saturatedEndpoints.includes(endpoint)
    ),
    endpointResults = input.requiredEndpoints.map(endpoint => {
      if (!saturatedEndpoints.includes(endpoint))
        return { endpoint, telemetry: EmptyTelemetry, saturated: false }
      const telemetry = input.priorHealthyTelemetry.get(endpoint)
      if (telemetry === undefined)
        throw new OppStressRampInvalidObservationError(
          "prior saturated endpoint telemetry is unavailable"
        )
      return { endpoint, telemetry, saturated: true }
    }),
    telemetry: OppEnvelopeTelemetryHealth = input.telemetry ?? EmptyTelemetry
  return {
    kind: "failed",
    outcome: RunEvidenceIterationOutcome.Breakage,
    lifecycle: RunEvidenceLifecycle.Failed,
    status: "failed_before_saturation",
    preserveCluster: true,
    requiredEndpoints: input.requiredEndpoints,
    saturatedEndpoints,
    missingEndpoints,
    startedAtMs: requirePersistenceDecimal(
      input.controllerStartedAtMs.toString(10)
    ),
    endedAtMs: requirePersistenceDecimal(
      input.controllerEndedAtMs.toString(10)
    ),
    controllerStartedAtMs: input.controllerStartedAtMs,
    controllerEndedAtMs: input.controllerEndedAtMs,
    schemaEvidence: { phases: [], endpointResults, telemetry },
    nextHealthyTelemetry: input.priorHealthyTelemetry,
    breakageCategory: input.category,
    breakageReason: input.reason,
    cause: input.cause
  }
}
