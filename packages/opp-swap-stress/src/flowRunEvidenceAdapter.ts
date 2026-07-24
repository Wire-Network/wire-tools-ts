import {
  OppEnvelopeTelemetryHealthKind,
  OppStressRampInvalidObservationError,
  RampBreakageCategory,
  RunEvidencePhaseStatus,
  RunEvidenceEndpoints,
  mapEnvelopeIntegrityIssue,
  parseOppEnvelopeTelemetryHealth,
  type DegradedOppEnvelopeTelemetryHealth,
  type OppEnvelopeTelemetryHealth,
  type OppStressRampIterationObservation,
  type RunEvidenceEndpoint,
  type RunEvidencePhase
} from "@wireio/test-opp-stress"

import type { SwapStressPhaseResult } from "./phaseRunnerMetricTypes.js"
import type {
  SwapStressIterationObservation,
  SwapStressTelemetryBreakageObservation
} from "./phaseRunnerTypes.js"
import { flowRunObservationCompatibility } from "./flowRunObservationCompatibility.js"

/** Convert observation-only flow evidence into the generic controller schema input. */
export function persistedSwapStressObservation(
  observation: SwapStressIterationObservation,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampIterationObservation {
  const degradation =
      observation.kind === "breakage" &&
      observation.breakageCategory === RampBreakageCategory.TelemetryIntegrity
        ? terminalTelemetry(observation)
        : null,
    phases = observation.evidence.phaseResults.flatMap(result =>
      persistedPhase(result, observation, degradation)
    ),
    endpointTelemetry = requiredEndpoints.map(endpoint => ({
      endpoint,
      telemetry:
        phases.findLast(phase => phase.endpoint === endpoint)?.telemetry ??
        degradation ??
        emptyTelemetry()
    })),
    telemetry = aggregateTelemetry(
      endpointTelemetry.map(entry => entry.telemetry),
      degradation
    ),
    fields = flowRunObservationCompatibility(observation)
  return observation.kind === "breakage"
    ? {
        kind: "breakage",
        ...fields,
        saturatedEndpoints: observation.saturatedEndpoints,
        observedNonRequiredEndpoints: observation.observedNonRequiredEndpoints,
        phases,
        endpointTelemetry,
        telemetry,
        breakageCategory: observation.breakageCategory,
        breakageReason: observation.breakageReason
      }
    : {
        kind: "completed",
        ...fields,
        saturatedEndpoints: observation.saturatedEndpoints,
        observedNonRequiredEndpoints: observation.observedNonRequiredEndpoints,
        phases,
        endpointTelemetry,
        telemetry
      }
}

function persistedPhase(
  result: SwapStressPhaseResult,
  observation: SwapStressIterationObservation,
  degradation: DegradedOppEnvelopeTelemetryHealth | null
): readonly RunEvidencePhase[] {
  if (result.measurement === "unmeasured") return []
  const provenance = result.provenance
  if (provenance.kind !== "opp_phase" || provenance.evidence.kind !== "recorded")
    throw new OppStressRampInvalidObservationError(
      "persisted flow phases require recorded canonical evidence"
    )
  const fields = {
      label: result.phase,
      endpoint: canonicalEndpoint(result.endpoint),
      strategy: provenance.strategy,
      baseline: provenance.evidence.baseline,
      window: provenance.window,
      artifactRefs: result.artifactRefs,
      metrics: {
        txSuccesses: result.txSuccesses,
        txFailures: result.txFailures,
        envelopeCount: result.envelopeCount,
        envelopeByteSizes: result.envelopeByteSizes,
        epochEnvelopeIndexes: provenance.epochEnvelopeIndexes,
        solanaOversized: provenance.solanaOversized,
        saturated: result.saturated
      }
    }
  if (result.measurement === "measured")
    return [
      {
        status: RunEvidencePhaseStatus.Completed,
        ...fields,
        telemetry: result.health
      }
    ]
  if (observation.kind !== "breakage")
    throw new OppStressRampInvalidObservationError(
      "pending persisted phase requires breakage"
    )
  return [
    {
      status: RunEvidencePhaseStatus.Breakage,
      ...fields,
      telemetry: degradation ?? terminalizeHealth(result.health),
      breakageCategory: observation.breakageCategory,
      breakageReason: observation.breakageReason
    }
  ]
}

function terminalTelemetry(
  observation: SwapStressTelemetryBreakageObservation
): DegradedOppEnvelopeTelemetryHealth {
  const degradation = observation.evidence.telemetryDegradation
  switch (degradation.kind) {
    case "deadline_exhausted":
      return terminalizeHealth(degradation.observation.health)
    case "baseline_capture_failed":
      const [firstIssue, ...remainingIssues] = degradation.issues
      return {
        kind: OppEnvelopeTelemetryHealthKind.Degraded,
        retryable: false,
        candidateCount: 0,
        validCount: 0,
        filteredCount: 0,
        issueCount: degradation.issues.length,
        issues: [
          mapEnvelopeIntegrityIssue(firstIssue),
          ...remainingIssues.map(mapEnvelopeIntegrityIssue)
        ]
      }
    default:
      return assertNever(degradation)
  }
}

function terminalizeHealth(
  health: Exclude<
    OppEnvelopeTelemetryHealth,
    { readonly kind: OppEnvelopeTelemetryHealthKind.Healthy }
  >
): DegradedOppEnvelopeTelemetryHealth {
  const parsed = parseOppEnvelopeTelemetryHealth({
    ...health,
    kind: OppEnvelopeTelemetryHealthKind.Degraded,
    retryable: false
  })
  if (parsed.kind !== OppEnvelopeTelemetryHealthKind.Degraded)
    throw new TypeError("terminal telemetry must be degraded")
  return parsed
}

function aggregateTelemetry(
  values: readonly OppEnvelopeTelemetryHealth[],
  degradation: DegradedOppEnvelopeTelemetryHealth | null
): OppEnvelopeTelemetryHealth {
  if (degradation !== null) return degradation
  if (
    values.every(value => value.kind === OppEnvelopeTelemetryHealthKind.Empty)
  )
    return emptyTelemetry()
  return {
    kind: OppEnvelopeTelemetryHealthKind.Healthy,
    retryable: false,
    candidateCount: values.reduce((sum, value) => sum + value.candidateCount, 0),
    validCount: values.reduce((sum, value) => sum + value.validCount, 0),
    filteredCount: values.reduce((sum, value) => sum + value.filteredCount, 0),
    issueCount: 0,
    issues: []
  }
}

function emptyTelemetry() {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  } as const
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected telemetry degradation: ${String(value)}`)
}

function canonicalEndpoint(value: string): RunEvidenceEndpoint {
  const endpoint = RunEvidenceEndpoints.find(candidate => candidate === value)
  if (endpoint === undefined)
    throw new OppStressRampInvalidObservationError(
      `flow phase endpoint is not canonical: ${value}`
    )
  return endpoint
}
