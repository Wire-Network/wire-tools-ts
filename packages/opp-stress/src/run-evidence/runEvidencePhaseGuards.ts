import { createEnvelopeBaseline } from "@wireio/debugging-shared"

import { OppEnvelopeTelemetryHealthKind } from "../envelopeMetricTypes.js"
import {
  RunEvidenceEndpoints,
  RunEvidencePhaseStatus,
  RunEvidenceSaturationStrategies
} from "./runEvidenceConstants.js"
import type {
  RunEvidencePhase,
  RunEvidencePhaseBaseline,
  RunEvidencePhaseMetrics,
  RunEvidencePhaseWindow
} from "./RunEvidenceRecordTypes.js"
import { isArtifactRefs } from "./runEvidenceArtifactGuards.js"
import {
  hasBreakageTelemetry,
  hasUniqueStrings,
  isBreakageCategory,
  isExactRecord,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isOrderedDecimals,
  isTelemetryHealth
} from "./runEvidenceGuards.js"

const CompletedPhaseKeys = [
    "status",
    "label",
    "endpoint",
    "strategy",
    "baseline",
    "window",
    "artifactRefs",
    "telemetry",
    "metrics"
  ],
  BreakagePhaseKeys = [
    ...CompletedPhaseKeys,
    "breakageCategory",
    "breakageReason"
  ],
  EnvelopeBaselineIdentityPattern = /^sha256:[0-9a-f]{64}$/

/** Narrow an unknown value to a recomputable phase variant. */
export function isPhase(value: unknown): value is RunEvidencePhase {
  const hasBreakage = hasBreakageFields(value)
  if (
    !isExactRecord(value, hasBreakage ? BreakagePhaseKeys : CompletedPhaseKeys)
  )
    return false
  if (
    (value.status !== RunEvidencePhaseStatus.Completed &&
      value.status !== RunEvidencePhaseStatus.Breakage) ||
    !isNonEmptyString(value.label) ||
    !isCanonicalEndpoint(value.endpoint) ||
    !RunEvidenceSaturationStrategies.some(
      strategy => strategy === value.strategy
    ) ||
    !isPhaseBaseline(value.baseline) ||
    !isPhaseWindow(value.window) ||
    !isArtifactRefs(value.artifactRefs) ||
    !isTelemetryHealth(value.telemetry) ||
    !isPhaseMetrics(value.metrics)
  )
    return false
  if (value.status === RunEvidencePhaseStatus.Completed)
    return (
      !hasBreakage &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy
    )
  if (!hasBreakage) return false
  return (
    isBreakageCategory(value.breakageCategory) &&
    isNonEmptyString(value.breakageReason) &&
    hasBreakageTelemetry(value.breakageCategory, value.telemetry) &&
    !value.metrics.saturated
  )
}

/** Narrow an unknown value to unique phase records. */
export function isPhases(value: unknown): value is readonly RunEvidencePhase[] {
  return (
    Array.isArray(value) &&
    value.every(isPhase) &&
    hasUniqueStrings(value.map(phase => phase.label))
  )
}

/** Require every current completed saturated phase to appear in cumulative claims. */
export function hasConsistentSaturationPhaseCoverage(input: {
  readonly phases: readonly RunEvidencePhase[]
  readonly requiredEndpoints: readonly string[]
  readonly saturatedEndpoints: readonly string[]
}): boolean {
  return input.phases.every(
    phase =>
      phase.status !== RunEvidencePhaseStatus.Completed ||
      !phase.metrics.saturated ||
      !input.requiredEndpoints.includes(phase.endpoint) ||
      input.saturatedEndpoints.includes(phase.endpoint)
  )
}

function isPhaseBaseline(value: unknown): value is RunEvidencePhaseBaseline {
  if (
    !isExactRecord(value, [
      "identity",
      "baseKeys",
      "observationOrdinal",
      "artifactRefs"
    ]) ||
    typeof value.identity !== "string" ||
    !EnvelopeBaselineIdentityPattern.test(value.identity) ||
    !isStringArray(value.baseKeys) ||
    !isOrderedDecimals(value.observationOrdinal, value.observationOrdinal) ||
    !isArtifactRefs(value.artifactRefs)
  )
    return false
  const canonical = createEnvelopeBaseline(value.baseKeys)
  return (
    value.identity === canonical.identity &&
    value.baseKeys.length === canonical.baseKeys.length &&
    value.baseKeys.every(
      (baseKey, index) => baseKey === canonical.baseKeys[index]
    )
  )
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === "string")
}

function isPhaseWindow(value: unknown): value is RunEvidencePhaseWindow {
  return (
    isExactRecord(value, [
      "startedAtMs",
      "endedAtMs",
      "epochStart",
      "epochEnd"
    ]) &&
    isOrderedDecimals(value.startedAtMs, value.endedAtMs) &&
    isOrderedDecimals(value.epochStart, value.epochEnd)
  )
}

function isPhaseMetrics(value: unknown): value is RunEvidencePhaseMetrics {
  if (
    !isExactRecord(value, [
      "txSuccesses",
      "txFailures",
      "envelopeCount",
      "envelopeByteSizes",
      "epochEnvelopeIndexes",
      "solanaOversized",
      "saturated"
    ]) ||
    !isNonNegativeSafeInteger(value.txSuccesses) ||
    !isNonNegativeSafeInteger(value.txFailures) ||
    !isNonNegativeSafeInteger(value.envelopeCount) ||
    !isCountArray(value.envelopeByteSizes) ||
    !isCountArray(value.epochEnvelopeIndexes) ||
    typeof value.solanaOversized !== "boolean" ||
    typeof value.saturated !== "boolean"
  )
    return false
  return (
    value.envelopeByteSizes.length === value.envelopeCount &&
    value.epochEnvelopeIndexes.length === value.envelopeCount &&
    (!value.saturated || value.envelopeCount > 0)
  )
}

function isCountArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isNonNegativeSafeInteger)
}

function isCanonicalEndpoint(
  value: unknown
): value is RunEvidencePhase["endpoint"] {
  return (
    typeof value === "string" &&
    RunEvidenceEndpoints.some(endpoint => endpoint === value)
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
