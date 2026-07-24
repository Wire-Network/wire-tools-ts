import { OppEnvelopeTelemetryHealthKind } from "../envelopeMetricTypes.js"
import {
  RunEvidenceIterationOutcome,
  RunEvidencePhaseStatus,
  RunEvidenceRecordKind,
  RunEvidenceSchemaVersion,
  RunEvidenceStage
} from "./runEvidenceConstants.js"
import type { RunEvidenceParseResult } from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceIteration } from "./RunEvidenceRecordTypes.js"
import {
  hasBreakageTelemetry,
  hasConsistentEndpointDecision,
  hasHealthyEndpointResults,
  isBreakageCategory,
  isEndpointResults,
  isEndpointSet,
  isExactRecord,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isOptionalEndpointSet,
  isOrderedDecimals,
  isPositiveSafeInteger,
  isTelemetryHealth,
  parseEvidence
} from "./runEvidenceGuards.js"
import {
  hasConsistentSaturationPhaseCoverage,
  isPhases
} from "./runEvidencePhaseGuards.js"

const CompletedIterationKeys = [
    "schemaVersion",
    "stage",
    "iterationIndex",
    "accountCount",
    "startedAtMs",
    "endedAtMs",
    "outcome",
    "requiredEndpoints",
    "saturatedEndpoints",
    "missingEndpoints",
    "endpointResults",
    "telemetry",
    "phases"
  ],
  BreakageIterationKeys = [
    ...CompletedIterationKeys,
    "breakageCategory",
    "breakageReason"
  ]

/**
 * Parse an unknown value as a schema-v1 iteration record.
 * @param input Unknown boundary value to parse.
 * @returns Typed success with the iteration or a stable parse failure.
 */
export function parseRunEvidenceIteration(
  input: unknown
): RunEvidenceParseResult<RunEvidenceIteration> {
  return parseEvidence(input, RunEvidenceRecordKind.Iteration, isIteration)
}

function isIteration(value: unknown): value is RunEvidenceIteration {
  const hasBreakage = hasBreakageFields(value)
  if (
    !isExactRecord(
      value,
      hasBreakage ? BreakageIterationKeys : CompletedIterationKeys
    )
  )
    return false
  if (
    value.schemaVersion !== RunEvidenceSchemaVersion ||
    value.stage !== RunEvidenceStage.Iteration ||
    !isNonNegativeSafeInteger(value.iterationIndex) ||
    !isPositiveSafeInteger(value.accountCount) ||
    !isOrderedDecimals(value.startedAtMs, value.endedAtMs) ||
    !isEndpointSet(value.requiredEndpoints) ||
    !isOptionalEndpointSet(value.saturatedEndpoints) ||
    !isOptionalEndpointSet(value.missingEndpoints) ||
    !isEndpointResults(value.endpointResults) ||
    !isTelemetryHealth(value.telemetry) ||
    !isPhases(value.phases) ||
    !hasConsistentEndpointDecision({
      requiredEndpoints: value.requiredEndpoints,
      saturatedEndpoints: value.saturatedEndpoints,
      missingEndpoints: value.missingEndpoints,
      endpointResults: value.endpointResults
    }) ||
    !hasConsistentSaturationPhaseCoverage({
      phases: value.phases,
      requiredEndpoints: value.requiredEndpoints,
      saturatedEndpoints: value.saturatedEndpoints
    })
  )
    return false
  if (value.outcome === RunEvidenceIterationOutcome.Saturated)
    return (
      !hasBreakage &&
      value.missingEndpoints.length === 0 &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy &&
      hasHealthyEndpointResults(value.endpointResults) &&
      value.phases.length > 0 &&
      value.phases.every(
        phase => phase.status === RunEvidencePhaseStatus.Completed
      )
    )
  if (value.outcome === RunEvidenceIterationOutcome.NotSaturated)
    return (
      !hasBreakage &&
      value.missingEndpoints.length > 0 &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy &&
      hasHealthyEndpointResults(value.endpointResults) &&
      value.phases.length > 0 &&
      value.phases.every(
        phase => phase.status === RunEvidencePhaseStatus.Completed
      )
    )
  return (
    hasBreakage &&
    value.outcome === RunEvidenceIterationOutcome.Breakage &&
    isBreakageCategory(value.breakageCategory) &&
    isNonEmptyString(value.breakageReason) &&
    hasBreakageTelemetry(value.breakageCategory, value.telemetry)
  )
}

function hasBreakageFields(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (Object.hasOwn(value, "breakageCategory") ||
      Object.hasOwn(value, "breakageReason"))
  )
}
