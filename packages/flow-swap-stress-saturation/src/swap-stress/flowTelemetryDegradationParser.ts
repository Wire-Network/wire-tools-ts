import { match } from "ts-pattern"

import {
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoints,
  type OppEnvelopeTelemetryHealth
} from "../stress-engine/index.js"
import type { EnvelopeIntegrityIssueSequence } from "../envelope-integrity/index.js"

import type {
  SwapStressPendingPhaseObservation,
  SwapStressTelemetryDegradation
} from "./phaseRunnerTelemetry.js"
import {
  hasExactObservationKeys,
  isEnvelopeIntegrityIssue,
  isMalformedRecords,
  isObservationCount,
  isObservationRecord,
  isObservationString,
  parsedHealth
} from "../observation-parsing/index.js"
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
  return match(value.kind)
    .with(
      "baseline_capture_failed",
      () =>
        hasExactObservationKeys(value, ["kind", "issues"]) &&
        isEnvelopeIntegrityIssueSequence(value.issues)
    )
    .with(
      "deadline_exhausted",
      () =>
        hasExactObservationKeys(value, ["kind", "observation"]) &&
        isPendingObservation(value.observation)
    )
    .otherwise(() => false)
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

/**
 * The evidence artifact refs, or `null` when the candidate is not valid
 * evidence. This package compiles with `strictNullChecks`, so the nullable leg
 * is a load-bearing part of the contract and is named rather than spelled
 * inline at the return position.
 */
type EvidenceArtifactRefs = readonly string[] | null

function evidenceArtifactRefs(value: unknown): EvidenceArtifactRefs {
  if (!isObservationRecord(value)) return null
  return match(value.kind)
    .with("not_recorded", () => [])
    .with("recorded", () =>
      Array.isArray(value.artifactRefs) ? value.artifactRefs : null
    )
    .otherwise(() => null)
}

/** `Extract` filter selecting the retryable legs of a telemetry observation. */
interface RetryableTelemetryDiscriminator {
  readonly kind:
    | OppEnvelopeTelemetryHealthKind.Empty
    | OppEnvelopeTelemetryHealthKind.PendingPublication
}

function isPendingHealth(
  health: OppEnvelopeTelemetryHealth | null
): health is Extract<
  OppEnvelopeTelemetryHealth,
  RetryableTelemetryDiscriminator
> {
  return (
    health?.kind === OppEnvelopeTelemetryHealthKind.Empty ||
    health?.kind === OppEnvelopeTelemetryHealthKind.PendingPublication
  )
}

function isCountArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isObservationCount)
}
