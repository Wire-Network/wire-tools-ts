import { OppEnvelopeTelemetryHealthKind } from "../envelopeMetricTypes.js"
import {
  RunEvidenceLifecycle,
  RunEvidenceRecordKind,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage
} from "./runEvidenceConstants.js"
import type { RunEvidenceParseResult } from "./RunEvidenceCoreTypes.js"
import type {
  RunEvidenceSetup,
  RunEvidenceTerminal
} from "./RunEvidenceRecordTypes.js"
import {
  hasBreakageTelemetry,
  hasConsistentEndpointDecision,
  hasHealthyEndpointResults,
  isBreakageCategory,
  isContiguousIterationRefs,
  isEndpointResults,
  isEndpointSet,
  isExactRecord,
  isNonEmptyString,
  isOptionalEndpointSet,
  isOrderedDecimals,
  isTelemetryHealth,
  parseEvidence
} from "./runEvidenceGuards.js"

const SuccessfulSetupKeys = [
    "schemaVersion",
    "stage",
    "status",
    "startedAtMs",
    "endedAtMs",
    "clusterConfigCreated"
  ],
  FailedSetupKeys = [
    ...SuccessfulSetupKeys,
    "breakageCategory",
    "breakageReason"
  ],
  TerminalKeys = [
    "schemaVersion",
    "stage",
    "lifecycle",
    "startedAtMs",
    "endedAtMs",
    "requiredEndpoints",
    "saturatedEndpoints",
    "missingEndpoints",
    "endpointResults",
    "telemetry",
    "iterationRefs",
    "preserveCluster"
  ],
  FailedTerminalKeys = [...TerminalKeys, "breakageCategory", "breakageReason"]

/**
 * Parse an unknown value as a standalone schema-v1 setup record.
 * @param input Unknown boundary value to parse.
 * @returns Typed success with the setup record or a stable parse failure.
 */
export function parseRunEvidenceSetup(
  input: unknown
): RunEvidenceParseResult<RunEvidenceSetup> {
  return parseEvidence(input, RunEvidenceRecordKind.Setup, isSetup)
}

/**
 * Parse an unknown value as a schema-v1 terminal record.
 * @param input Unknown boundary value to parse.
 * @returns Typed success with the terminal record or a stable parse failure.
 */
export function parseRunEvidenceTerminal(
  input: unknown
): RunEvidenceParseResult<RunEvidenceTerminal> {
  return parseEvidence(input, RunEvidenceRecordKind.Terminal, isTerminal)
}

function isSetup(value: unknown): value is RunEvidenceSetup {
  const hasBreakage = hasBreakageFields(value),
    keys = hasBreakage ? FailedSetupKeys : SuccessfulSetupKeys
  if (
    !isExactRecord(value, keys) ||
    value.schemaVersion !== RunEvidenceSchemaVersion ||
    value.stage !== RunEvidenceStage.Setup ||
    !isOrderedDecimals(value.startedAtMs, value.endedAtMs)
  )
    return false
  if (value.status === RunEvidenceSetupStatus.Succeeded)
    return !hasBreakage && value.clusterConfigCreated === true
  return (
    hasBreakage &&
    value.status === RunEvidenceSetupStatus.Failed &&
    typeof value.clusterConfigCreated === "boolean" &&
    isBreakageCategory(value.breakageCategory) &&
    isNonEmptyString(value.breakageReason)
  )
}

function isTerminal(value: unknown): value is RunEvidenceTerminal {
  const hasBreakage = hasBreakageFields(value)
  if (
    !isExactRecord(value, hasBreakage ? FailedTerminalKeys : TerminalKeys) ||
    value.schemaVersion !== RunEvidenceSchemaVersion ||
    value.stage !== RunEvidenceStage.Terminal ||
    !isOrderedDecimals(value.startedAtMs, value.endedAtMs) ||
    !isEndpointSet(value.requiredEndpoints) ||
    !isOptionalEndpointSet(value.saturatedEndpoints) ||
    !isOptionalEndpointSet(value.missingEndpoints) ||
    !isEndpointResults(value.endpointResults) ||
    !isTelemetryHealth(value.telemetry) ||
    !isContiguousIterationRefs(value.iterationRefs) ||
    typeof value.preserveCluster !== "boolean" ||
    !hasConsistentEndpointDecision({
      requiredEndpoints: value.requiredEndpoints,
      saturatedEndpoints: value.saturatedEndpoints,
      missingEndpoints: value.missingEndpoints,
      endpointResults: value.endpointResults
    })
  )
    return false
  if (value.lifecycle === RunEvidenceLifecycle.Saturated)
    return (
      !hasBreakage &&
      value.iterationRefs.length > 0 &&
      value.missingEndpoints.length === 0 &&
      !value.preserveCluster &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy &&
      hasHealthyEndpointResults(value.endpointResults)
    )
  if (value.lifecycle === RunEvidenceLifecycle.Incomplete)
    return (
      !hasBreakage &&
      value.iterationRefs.length > 0 &&
      value.missingEndpoints.length > 0 &&
      value.preserveCluster &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy &&
      hasHealthyEndpointResults(value.endpointResults)
    )
  if (
    !hasBreakage ||
    !value.preserveCluster ||
    !isBreakageCategory(value.breakageCategory) ||
    !isNonEmptyString(value.breakageReason) ||
    !hasBreakageTelemetry(value.breakageCategory, value.telemetry)
  )
    return false
  if (value.lifecycle === RunEvidenceLifecycle.Failed)
    return value.iterationRefs.length > 0
  if (value.lifecycle !== RunEvidenceLifecycle.SetupFailed) return false
  return (
    value.iterationRefs.length === 0 &&
    value.saturatedEndpoints.length === 0 &&
    value.missingEndpoints.length === value.requiredEndpoints.length
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
