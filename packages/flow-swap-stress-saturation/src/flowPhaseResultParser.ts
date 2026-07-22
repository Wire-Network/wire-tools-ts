import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryHealthParseError,
  parseOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import type {
  MalformedOppEnvelopeRecord,
  OppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryIssue
} from "@wireio/test-opp-stress"

import type { SwapStressPhaseResult } from "./phaseRunnerMetricTypes.js"
import type { SwapStressPayoutObservation } from "./phaseRunnerTypes.js"
import {
  hasExactObservationKeys,
  isObservationCount,
  isObservationDecimal,
  isObservationRecord,
  isObservationString,
  observationValuesEqual
} from "./flowObservationParserSupport.js"
import { isSwapStressPhaseProvenance } from "./flowPhaseProvenanceParser.js"

const ObservedKeys = [
    "measurement",
    "phase",
    "saturated",
    "envelopeCount",
    "envelopeByteSizes",
    "endpoint",
    "epochStart",
    "epochEnd",
    "health",
    "malformedRecords",
    "artifactRefs",
    "provenance",
    "txSuccesses",
    "txFailures",
    "observationStartedAtMs",
    "observationEndedAtMs",
    "payout"
  ] as const,
  UnmeasuredKeys = [...ObservedKeys, "unmeasuredReason"] as const

type ObservedPhaseRecord = Readonly<Record<string, unknown>> & {
  readonly envelopeCount: number
}

/**
 * Validate one exact measured, pending, or unmeasured phase result.
 * @param value Unknown phase result candidate.
 * @returns Whether the complete discriminated phase structure is valid.
 */
export function isSwapStressPhaseResult(
  value: unknown
): value is SwapStressPhaseResult {
  if (!isObservationRecord(value)) return false
  switch (value.measurement) {
    case "measured":
      return hasObservedShape(value) && isMeasured(value)
    case "pending":
      return hasObservedShape(value) && isPending(value)
    case "unmeasured":
      return hasUnmeasuredShape(value)
    default:
      return false
  }
}

function hasObservedShape(
  value: Readonly<Record<string, unknown>>
): value is ObservedPhaseRecord {
  return (
    hasExactObservationKeys(value, ObservedKeys) &&
    hasCommonValues(value) &&
    typeof value.saturated === "boolean" &&
    isObservationCount(value.envelopeCount) &&
    (!value.saturated || value.envelopeCount > 0) &&
    isCountArray(value.envelopeByteSizes) &&
    value.envelopeByteSizes.length === value.envelopeCount &&
    isObservationDecimal(value.epochStart) &&
    isObservationDecimal(value.epochEnd) &&
    BigInt(value.epochStart) <= BigInt(value.epochEnd) &&
    isStringArray(value.artifactRefs)
  )
}

function hasCommonValues(value: Readonly<Record<string, unknown>>): boolean {
  return (
    isObservationString(value.phase) &&
    isObservationString(value.endpoint) &&
    isObservationCount(value.txSuccesses) &&
    isObservationCount(value.txFailures) &&
    isObservationCount(value.observationStartedAtMs) &&
    isObservationCount(value.observationEndedAtMs) &&
    value.observationStartedAtMs <= value.observationEndedAtMs &&
    (value.payout === null || isPayout(value.payout, value.phase))
  )
}

function isMeasured(value: ObservedPhaseRecord): boolean {
  const health = parsedHealth(value.health)
  return (
    health?.kind === OppEnvelopeTelemetryHealthKind.Healthy &&
    isMalformedRecords(value.malformedRecords, health) &&
    isSwapStressPhaseProvenance(
      value.provenance,
      value.artifactRefs,
      value.envelopeCount
    )
  )
}

function isPending(value: ObservedPhaseRecord): boolean {
  const health = parsedHealth(value.health)
  return (
    value.saturated === false &&
    (health?.kind === OppEnvelopeTelemetryHealthKind.Empty ||
      health?.kind === OppEnvelopeTelemetryHealthKind.PendingPublication) &&
    isMalformedRecords(value.malformedRecords, health) &&
    isSwapStressPhaseProvenance(
      value.provenance,
      value.artifactRefs,
      value.envelopeCount
    ) &&
    isObservationRecord(value.provenance) &&
    value.provenance.kind === "opp_phase"
  )
}

function hasUnmeasuredShape(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasExactObservationKeys(value, UnmeasuredKeys) &&
    hasCommonValues(value) &&
    (value.unmeasuredReason === "collector_not_configured" ||
      value.unmeasuredReason === "collection_failed" ||
      value.unmeasuredReason === "phase_not_run") &&
    value.saturated === false &&
    value.envelopeCount === 0 &&
    Array.isArray(value.envelopeByteSizes) &&
    value.envelopeByteSizes.length === 0 &&
    value.epochStart === "0" &&
    value.epochEnd === "0" &&
    value.health === null &&
    Array.isArray(value.malformedRecords) &&
    value.malformedRecords.length === 0 &&
    Array.isArray(value.artifactRefs) &&
    value.artifactRefs.length === 0 &&
    value.provenance === null
  )
}

/**
 * Parse exact health or return null for a known telemetry parse failure.
 * @param value Unknown telemetry health candidate.
 * @returns Parsed health, or null when the public parser rejects it.
 */
export function parsedHealth(
  value: unknown
): OppEnvelopeTelemetryHealth | null {
  try {
    return parseOppEnvelopeTelemetryHealth(value)
  } catch (error) {
    if (error instanceof OppEnvelopeTelemetryHealthParseError) return null
    throw error
  }
}

/**
 * Validate exact malformed records against the parsed health issue set.
 * @param value Unknown malformed-record collection.
 * @param health Parsed canonical health owning the issue set.
 * @returns Whether each record exactly mirrors one health issue.
 */
export function isMalformedRecords(
  value: unknown,
  health: OppEnvelopeTelemetryHealth
): value is readonly MalformedOppEnvelopeRecord[] {
  const issues: readonly OppEnvelopeTelemetryIssue[] = health.issues
  if (!Array.isArray(value)) return false
  switch (health.kind) {
    case OppEnvelopeTelemetryHealthKind.PendingPublication:
      break
    case OppEnvelopeTelemetryHealthKind.Empty:
    case OppEnvelopeTelemetryHealthKind.Healthy:
    case OppEnvelopeTelemetryHealthKind.Degraded:
      return value.length === 0
    default:
      return assertNeverHealth(health)
  }
  if (value.length !== issues.length) return false
  const unmatchedIssues = [...issues]
  return value.every(record => {
    if (
      !isObservationRecord(record) ||
      !hasExactObservationKeys(record, ["key", "reason", "issue"]) ||
      typeof record.key !== "string" ||
      !isObservationString(record.reason)
    )
      return false
    const issueIndex = unmatchedIssues.findIndex(
      issue =>
        issue.baseKey === record.key &&
        issue.code === record.reason &&
        observationValuesEqual(issue, record.issue)
    )
    if (issueIndex < 0) return false
    unmatchedIssues.splice(issueIndex, 1)
    return true
  })
}

function assertNeverHealth(value: never): never {
  throw new TypeError(`Unexpected malformed-record health: ${String(value)}`)
}

function isPayout(
  value: unknown,
  parentPhase: unknown
): value is SwapStressPayoutObservation {
  if (
    !isObservationRecord(value) ||
    !hasExactObservationKeys(value, [
      "phase",
      "expectedCount",
      "minimumObservedCount",
      "targetAmount",
      "targets",
      "observedCount"
    ])
  )
    return false
  return (
    value.phase === parentPhase &&
    (value.phase === "phase-1" || value.phase === "phase-2") &&
    isObservationCount(value.expectedCount) &&
    isObservationCount(value.minimumObservedCount) &&
    value.minimumObservedCount <= value.expectedCount &&
    typeof value.targetAmount === "bigint" &&
    value.targetAmount >= 0n &&
    Array.isArray(value.targets) &&
    value.targets.length === value.expectedCount &&
    value.targets.every(
      (target, index) =>
        isObservationRecord(target) &&
        hasExactObservationKeys(target, ["index", "address"]) &&
        isObservationCount(target.index) &&
        target.index === index &&
        isObservationString(target.address)
    ) &&
    isObservationCount(value.observedCount) &&
    value.observedCount <= value.expectedCount
  )
}

function isCountArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isObservationCount)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isObservationString)
}
