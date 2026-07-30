import { match } from "ts-pattern"

import { OppEnvelopeTelemetryHealthKind } from "@wireio/test-opp-stress"

import type { SwapStressPhaseResult } from "./phaseRunnerMetricTypes.js"
import type { SwapStressPayoutObservation } from "./phaseRunnerTypes.js"
import {
  hasExactObservationKeys,
  isMalformedRecords,
  isObservationCount,
  isObservationDecimal,
  isObservationRecord,
  isObservationString,
  parsedHealth
} from "@wireio/opp-stress-harness"
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

/** The envelope tally an observed phase record is narrowed to carry. */
interface ObservedPhaseEnvelopeCount {
  readonly envelopeCount: number
}

type ObservedPhaseRecord = Readonly<Record<string, unknown>> &
  ObservedPhaseEnvelopeCount

/**
 * Validate one exact measured, pending, or unmeasured phase result.
 * @param value Unknown phase result candidate.
 * @returns Whether the complete discriminated phase structure is valid.
 */
export function isSwapStressPhaseResult(
  value: unknown
): value is SwapStressPhaseResult {
  if (!isObservationRecord(value)) return false
  return match(value.measurement)
    .with("measured", () => hasObservedShape(value) && isMeasured(value))
    .with("pending", () => hasObservedShape(value) && isPending(value))
    .with("unmeasured", () => hasUnmeasuredShape(value))
    .otherwise(() => false)
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
