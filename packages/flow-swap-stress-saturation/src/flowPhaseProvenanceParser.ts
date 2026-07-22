import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import {
  RunEvidenceSaturationStrategies,
  type OppPhaseMetricEvidence,
  type RunEvidencePhaseWindow
} from "@wireio/test-opp-stress"

import type { SwapStressPhaseEnvelopeMetrics } from "./phaseRunnerMetricTypes.js"
import {
  hasExactObservationKeys,
  isObservationCount,
  isObservationDecimal,
  isObservationRecord,
  isObservationString,
  isOrderedDecimalWindow,
  observationValuesEqual
} from "./flowObservationParserSupport.js"

type PhaseProvenance = Exclude<
  SwapStressPhaseEnvelopeMetrics["provenance"],
  null
>
type CapturedArtifacts = Extract<
  OppPhaseMetricEvidence,
  { readonly kind: "recorded" }
>["artifacts"]

const StrictKeys = ["kind", "solanaOversized", "epochEnvelopeIndexes"] as const,
  OppPhaseKeys = [
    "kind",
    "strategy",
    "window",
    "solanaOversized",
    "epochEnvelopeIndexes",
    "selectedArtifacts",
    "evidence"
  ] as const

/**
 * Validate exact strict-snapshot or OPP-phase provenance and ref coherence.
 * @param value Unknown provenance candidate.
 * @param artifactRefs Top-level phase artifact refs.
 * @param envelopeCount Number of envelopes represented by this provenance.
 * @returns Whether provenance and refs form one exact valid branch.
 */
export function isSwapStressPhaseProvenance(
  value: unknown,
  artifactRefs: unknown,
  envelopeCount: number
): value is PhaseProvenance {
  if (!isObservationRecord(value)) return false
  switch (value.kind) {
    case "strict_snapshot":
      return (
        hasExactObservationKeys(value, StrictKeys) &&
        typeof value.solanaOversized === "boolean" &&
        isCountArray(value.epochEnvelopeIndexes) &&
        value.epochEnvelopeIndexes.length === envelopeCount &&
        Array.isArray(artifactRefs) &&
        artifactRefs.length === 0
      )
    case "opp_phase":
      return (
        hasExactObservationKeys(value, OppPhaseKeys) &&
        RunEvidenceSaturationStrategies.some(
          strategy => strategy === value.strategy
        ) &&
        isRunEvidenceWindow(value.window) &&
        typeof value.solanaOversized === "boolean" &&
        isCountArray(value.epochEnvelopeIndexes) &&
        value.epochEnvelopeIndexes.length === envelopeCount &&
        isSelectedArtifacts(value.selectedArtifacts) &&
        isMetricEvidence(value.evidence, artifactRefs)
      )
    default:
      return false
  }
}

/**
 * Validate exact generic metric evidence against top-level artifact refs.
 * @param value Unknown metric evidence candidate.
 * @param artifactRefs Top-level phase artifact refs.
 * @returns Whether evidence and refs are exact and coherent.
 */
export function isMetricEvidence(
  value: unknown,
  artifactRefs: unknown
): value is OppPhaseMetricEvidence {
  if (!isObservationRecord(value) || !Array.isArray(artifactRefs)) return false
  switch (value.kind) {
    case "not_recorded":
      return (
        hasExactObservationKeys(value, ["kind", "baseline"]) &&
        isBaseline(value.baseline, false) &&
        artifactRefs.length === 0
      )
    case "recorded":
      const capturedRefs = capturedArtifactRefs(value.artifacts)
      return (
        hasExactObservationKeys(value, [
          "kind",
          "baseline",
          "artifacts",
          "artifactRefs"
        ]) &&
        isBaseline(value.baseline, true) &&
        capturedRefs !== null &&
        isStringArray(value.artifactRefs) &&
        isStringArray(artifactRefs) &&
        observationValuesEqual(value.artifactRefs, artifactRefs) &&
        observationValuesEqual(value.artifactRefs, capturedRefs)
      )
    default:
      return false
  }
}

/**
 * Validate one exact precision-safe phase window.
 * @param value Unknown phase window candidate.
 * @returns Whether every decimal is canonical and both ranges are ordered.
 */
export function isRunEvidenceWindow(
  value: unknown
): value is RunEvidencePhaseWindow {
  return (
    isObservationRecord(value) &&
    hasExactObservationKeys(value, [
      "startedAtMs",
      "endedAtMs",
      "epochStart",
      "epochEnd"
    ]) &&
    isOrderedDecimalWindow(value.startedAtMs, value.endedAtMs) &&
    isOrderedDecimalWindow(value.epochStart, value.epochEnd)
  )
}

function isBaseline(value: unknown, recorded: boolean): boolean {
  if (!isObservationRecord(value)) return false
  if (!recorded)
    return (
      hasExactObservationKeys(value, ["identity", "artifactRefs"]) &&
      isObservationString(value.identity) &&
      isStringArray(value.artifactRefs)
    )
  if (
    !hasExactObservationKeys(value, [
      "identity",
      "baseKeys",
      "observationOrdinal",
      "artifactRefs"
    ]) ||
    !isObservationString(value.identity) ||
    !Array.isArray(value.baseKeys) ||
    !value.baseKeys.every(baseKey => typeof baseKey === "string") ||
    !isObservationDecimal(value.observationOrdinal) ||
    !isStringArray(value.artifactRefs)
  )
    return false
  const canonical = createEnvelopeBaseline(value.baseKeys)
  return (
    value.identity === canonical.identity &&
    observationValuesEqual(value.baseKeys, canonical.baseKeys)
  )
}

function isSelectedArtifacts(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      artifact =>
        isObservationRecord(artifact) &&
        hasExactObservationKeys(artifact, [
          "baseKey",
          "epoch",
          "index",
          "dataSha256",
          "dataMtimeNs",
          "metadataMtimeNs"
        ]) &&
        isObservationString(artifact.baseKey) &&
        isObservationCount(artifact.epoch) &&
        isObservationCount(artifact.index) &&
        isObservationString(artifact.dataSha256) &&
        isObservationDecimal(artifact.dataMtimeNs) &&
        isObservationDecimal(artifact.metadataMtimeNs)
    )
  )
}

function capturedArtifactRefs(value: unknown): readonly string[] | null {
  return isCapturedArtifacts(value)
    ? value.flatMap(artifact => [
        artifact.immutableRefs.data.path,
        artifact.immutableRefs.metadata.path
      ])
    : null
}

function isCapturedArtifacts(value: unknown): value is CapturedArtifacts {
  return (
    Array.isArray(value) &&
    value.every(
      artifact =>
        isObservationRecord(artifact) &&
        hasExactObservationKeys(artifact, ["baseKey", "immutableRefs"]) &&
        isObservationString(artifact.baseKey) &&
        isImmutableRefs(artifact.immutableRefs)
    )
  )
}

function isImmutableRefs(value: unknown): boolean {
  return (
    isObservationRecord(value) &&
    hasExactObservationKeys(value, ["data", "metadata"]) &&
    isArtifactFile(value.data) &&
    isArtifactFile(value.metadata)
  )
}

function isArtifactFile(value: unknown): boolean {
  return (
    isObservationRecord(value) &&
    hasExactObservationKeys(value, ["path", "sha256"]) &&
    isObservationString(value.path) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  )
}

function isCountArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(isObservationCount)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isObservationString)
}
