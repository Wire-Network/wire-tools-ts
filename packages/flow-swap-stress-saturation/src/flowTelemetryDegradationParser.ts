import {
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoints,
  type OppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import type { EnvelopeIntegrityIssueSequence } from "@wireio/debugging-shared"

import type {
  SwapStressPendingPhaseObservation,
  SwapStressTelemetryDegradation
} from "./phaseRunnerTelemetry.js"
import { isEnvelopeIntegrityIssue } from "./flowIntegrityIssueParser.js"
import {
  hasExactObservationKeys,
  isObservationCount,
  isObservationRecord,
  isObservationString
} from "./flowObservationParserSupport.js"
import { isMalformedRecords, parsedHealth } from "./flowPhaseResultParser.js"
import { isSwapStressPhaseProvenance } from "./flowPhaseProvenanceParser.js"

/**
 * Validate an exact baseline failure or deadline-exhausted degradation.
 * @param value Unknown telemetry degradation candidate.
 * @returns Whether the complete degradation branch is exact.
 */
export function isSwapStressTelemetryDegradation(
  value: unknown
): value is SwapStressTelemetryDegradation {
  if (!isObservationRecord(value)) return false
  switch (value.kind) {
    case "baseline_capture_failed":
      return (
        hasExactObservationKeys(value, ["kind", "issues"]) &&
        isEnvelopeIntegrityIssueSequence(value.issues)
      )
    case "deadline_exhausted":
      return (
        hasExactObservationKeys(value, ["kind", "observation"]) &&
        isPendingObservation(value.observation)
      )
    default:
      return false
  }
}

function isEnvelopeIntegrityIssueSequence(
  value: unknown
): value is EnvelopeIntegrityIssueSequence {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isEnvelopeIntegrityIssue)
  )
}

function isPendingObservation(
  value: unknown
): value is SwapStressPendingPhaseObservation {
  if (
    !isObservationRecord(value) ||
    !hasExactObservationKeys(value, [
      "phase",
      "endpoint",
      "strategy",
      "window",
      "saturated",
      "solanaOversized",
      "envelopeCount",
      "envelopeByteSizes",
      "epochEnvelopeIndexes",
      "health",
      "malformedRecords",
      "selectedArtifacts",
      "evidence"
    ]) ||
    !isObservationString(value.phase) ||
    !RunEvidenceEndpoints.some(endpoint => endpoint === value.endpoint) ||
    value.saturated !== false ||
    typeof value.solanaOversized !== "boolean" ||
    !isObservationCount(value.envelopeCount) ||
    !isCountArray(value.envelopeByteSizes) ||
    !isCountArray(value.epochEnvelopeIndexes)
  )
    return false
  const health = parsedHealth(value.health),
    artifactRefs = evidenceArtifactRefs(value.evidence),
    provenance = {
      kind: "opp_phase",
      strategy: value.strategy,
      window: value.window,
      solanaOversized: value.solanaOversized,
      epochEnvelopeIndexes: value.epochEnvelopeIndexes,
      selectedArtifacts: value.selectedArtifacts,
      evidence: value.evidence
    }
  return (
    isPendingHealth(health) &&
    isMalformedRecords(value.malformedRecords, health) &&
    artifactRefs !== null &&
    isSwapStressPhaseProvenance(provenance, artifactRefs, value.envelopeCount)
  )
}

function evidenceArtifactRefs(value: unknown): readonly string[] | null {
  if (!isObservationRecord(value)) return null
  switch (value.kind) {
    case "not_recorded":
      return []
    case "recorded":
      return Array.isArray(value.artifactRefs) ? value.artifactRefs : null
    default:
      return null
  }
}

function isPendingHealth(
  health: OppEnvelopeTelemetryHealth | null
): health is Extract<
  OppEnvelopeTelemetryHealth,
  {
    readonly kind:
      | OppEnvelopeTelemetryHealthKind.Empty
      | OppEnvelopeTelemetryHealthKind.PendingPublication
  }
> {
  return (
    health?.kind === OppEnvelopeTelemetryHealthKind.Empty ||
    health?.kind === OppEnvelopeTelemetryHealthKind.PendingPublication
  )
}

function isCountArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isObservationCount)
}
