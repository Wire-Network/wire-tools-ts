import { OppEnvelopeTelemetryHealthKind } from "./envelopeMetricTypes.js"
import { OppStressRampInvalidObservationError } from "./rampObservation.js"
import type {
  OppStressRampDeferredIterationObservation,
  OppStressRampHealthyEndpointTelemetry,
  OppStressRampIterationObservation,
  OppStressRampResultStatus
} from "./rampControllerTypes.js"
import type { OppStressRampDeferredEvidenceIterationObservation } from "./rampDeferredEvidenceTypes.js"
import {
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  type RampBreakageCategory,
  type RunEvidenceDecimal,
  type RunEvidenceEndpoint,
  type RunEvidenceEndpointResult,
  type RunEvidencePhase
} from "./runEvidenceTypes.js"
import type { OppEnvelopeTelemetryHealth } from "./envelopeMetricTypes.js"
import { requirePersistenceDecimal } from "./run-evidence/runEvidencePersistenceValidation.js"

/** Existing schema-v1 or no-payload deferred parsed observation. */
export type LegacyRampDecisionObservation =
  | {
      readonly mode: "schema_v1"
      readonly value: OppStressRampIterationObservation
    }
  | {
      readonly mode: "deferred_flow_migration"
      readonly value: OppStressRampDeferredIterationObservation
    }

/** Controller mode paired with its already parsed callback observation. */
export type RampDecisionObservation<TEvidence extends object = object> =
  | LegacyRampDecisionObservation
  | {
      readonly mode: "deferred_flow_migration"
      readonly value: OppStressRampDeferredEvidenceIterationObservation<TEvidence>
    }

/** Inputs owned by the controller before one canonical classification. */
export type RampDecisionInput<TEvidence extends object = object> = {
  readonly observation: RampDecisionObservation<TEvidence>
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly priorSaturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly priorHealthyTelemetry: OppStressRampHealthyEndpointTelemetry
  readonly accountCount: number
  readonly maxCount: number
  readonly controllerStartedAtMs: number
  readonly controllerEndedAtMs: number
}

type SchemaDecisionEvidence = {
  readonly phases: readonly RunEvidencePhase[]
  readonly endpointResults: readonly RunEvidenceEndpointResult[]
  readonly telemetry: OppEnvelopeTelemetryHealth
}

type RampDecisionFields = {
  readonly outcome: RunEvidenceIterationOutcome
  readonly preserveCluster: boolean
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly missingEndpoints: readonly RunEvidenceEndpoint[]
  readonly startedAtMs: RunEvidenceDecimal
  readonly endedAtMs: RunEvidenceDecimal
  readonly controllerStartedAtMs: number
  readonly controllerEndedAtMs: number
  readonly schemaEvidence: SchemaDecisionEvidence | null
  readonly nextHealthyTelemetry: OppStressRampHealthyEndpointTelemetry
}

type RampFailureFields = {
  readonly breakageCategory: RampBreakageCategory
  readonly breakageReason: string
  readonly cause: unknown | null
}

/** Exhaustive canonical outcome shared by persistence and returned status. */
export type CanonicalRampDecision =
  | (RampDecisionFields & {
      readonly kind: "continue"
      readonly outcome: RunEvidenceIterationOutcome.NotSaturated
      readonly lifecycle: null
      readonly status: null
      readonly preserveCluster: true
    })
  | (RampDecisionFields &
      RampFailureFields & {
        readonly kind: "failed"
        readonly outcome: RunEvidenceIterationOutcome.Breakage
        readonly lifecycle: RunEvidenceLifecycle.Failed
        readonly status: "failed_before_saturation"
        readonly preserveCluster: true
      })
  | (RampDecisionFields & {
      readonly kind: "saturated"
      readonly outcome: RunEvidenceIterationOutcome.Saturated
      readonly lifecycle: RunEvidenceLifecycle.Saturated
      readonly status: "saturated"
      readonly preserveCluster: false
    })
  | (RampDecisionFields & {
      readonly kind: "partial_saturation"
      readonly outcome: RunEvidenceIterationOutcome.NotSaturated
      readonly lifecycle: RunEvidenceLifecycle.Incomplete
      readonly status: "partial_saturation"
      readonly preserveCluster: true
    })
  | (RampDecisionFields & {
      readonly kind: "saturation_not_reached"
      readonly outcome: RunEvidenceIterationOutcome.NotSaturated
      readonly lifecycle: RunEvidenceLifecycle.Incomplete
      readonly status: "saturation_not_reached"
      readonly preserveCluster: true
    })

/** Apply breakage, saturation, exact-max, then continue precedence once. */
export function decideRampIteration<TEvidence extends object = object>(
  input: RampDecisionInput<TEvidence>
): CanonicalRampDecision {
  const currentSaturated = input.observation.value.saturatedEndpoints,
    saturatedEndpoints = input.requiredEndpoints.filter(
      endpoint =>
        input.priorSaturatedEndpoints.includes(endpoint) ||
        currentSaturated.includes(endpoint)
    ),
    missingEndpoints = input.requiredEndpoints.filter(
      endpoint => !saturatedEndpoints.includes(endpoint)
    ),
    schema = schemaDecisionEvidence(input, saturatedEndpoints),
    base = {
      requiredEndpoints: input.requiredEndpoints,
      saturatedEndpoints,
      missingEndpoints,
      startedAtMs: controllerDecimal(input.controllerStartedAtMs),
      endedAtMs: controllerDecimal(input.controllerEndedAtMs),
      controllerStartedAtMs: input.controllerStartedAtMs,
      controllerEndedAtMs: input.controllerEndedAtMs,
      schemaEvidence: schema.evidence,
      nextHealthyTelemetry: schema.nextHealthyTelemetry
    }
  if (input.observation.value.kind === "breakage")
    return {
      ...base,
      kind: "failed",
      outcome: RunEvidenceIterationOutcome.Breakage,
      lifecycle: RunEvidenceLifecycle.Failed,
      status: "failed_before_saturation",
      preserveCluster: true,
      breakageCategory: input.observation.value.breakageCategory,
      breakageReason: input.observation.value.breakageReason,
      cause: null
    }
  if (missingEndpoints.length === 0)
    return {
      ...base,
      kind: "saturated",
      outcome: RunEvidenceIterationOutcome.Saturated,
      lifecycle: RunEvidenceLifecycle.Saturated,
      status: "saturated",
      preserveCluster: false
    }
  if (input.accountCount >= input.maxCount) {
    if (saturatedEndpoints.length > 0)
      return {
        ...base,
        kind: "partial_saturation",
        outcome: RunEvidenceIterationOutcome.NotSaturated,
        lifecycle: RunEvidenceLifecycle.Incomplete,
        status: "partial_saturation",
        preserveCluster: true
      }
    return {
      ...base,
      kind: "saturation_not_reached",
      outcome: RunEvidenceIterationOutcome.NotSaturated,
      lifecycle: RunEvidenceLifecycle.Incomplete,
      status: "saturation_not_reached",
      preserveCluster: true
    }
  }
  return {
    ...base,
    kind: "continue",
    outcome: RunEvidenceIterationOutcome.NotSaturated,
    lifecycle: null,
    status: null,
    preserveCluster: true
  }
}

function schemaDecisionEvidence(
  input: RampDecisionInput,
  saturatedEndpoints: readonly RunEvidenceEndpoint[]
): {
  readonly evidence: SchemaDecisionEvidence | null
  readonly nextHealthyTelemetry: OppStressRampHealthyEndpointTelemetry
} {
  if (input.observation.mode === "deferred_flow_migration")
    return {
      evidence: null,
      nextHealthyTelemetry: input.priorHealthyTelemetry
    }
  const telemetryByEndpoint = new Map(
      input.observation.value.endpointTelemetry.map(entry => [
        entry.endpoint,
        entry.telemetry
      ])
    ),
    nextHealthyTelemetry = new Map(input.priorHealthyTelemetry),
    endpointResults = input.requiredEndpoints.map(endpoint => {
      const prior = input.priorHealthyTelemetry.get(endpoint)
      if (prior !== undefined)
        return { endpoint, telemetry: prior, saturated: true }
      const current = telemetryByEndpoint.get(endpoint)
      if (current === undefined)
        throw new OppStressRampInvalidObservationError(
          "endpoint telemetry is missing after parsing"
        )
      const saturated = saturatedEndpoints.includes(endpoint)
      if (saturated) {
        if (current.kind !== OppEnvelopeTelemetryHealthKind.Healthy)
          throw new OppStressRampInvalidObservationError(
            "new saturation requires healthy endpoint telemetry"
          )
        nextHealthyTelemetry.set(endpoint, current)
      }
      return { endpoint, telemetry: current, saturated }
    })
  return {
    evidence: {
      phases: input.observation.value.phases,
      endpointResults,
      telemetry: input.observation.value.telemetry
    },
    nextHealthyTelemetry
  }
}

function controllerDecimal(value: number): RunEvidenceDecimal {
  return requirePersistenceDecimal(value.toString(10))
}
