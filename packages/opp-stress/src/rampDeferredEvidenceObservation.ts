import type {
  OppStressRampDeferredEvidenceBreakageObservation,
  OppStressRampDeferredEvidenceCompletedObservation,
  OppStressRampDeferredEvidenceIterationObservation,
  OppStressRampDeferredEvidenceParseContext,
  OppStressRampDeferredEvidenceParser
} from "./rampDeferredEvidenceTypes.js"
import {
  OppStressRampInvalidObservationError,
  parseDiagnosticEndpoints,
  parseSaturatedEndpoints
} from "./rampObservation.js"
import {
  snapshotRampObservationVariantData,
  type RampObservationRecord
} from "./rampObservationSnapshot.js"
import {
  isBreakageCategory,
  isNonEmptyString
} from "./run-evidence/runEvidencePrimitiveGuards.js"
import type { RunEvidenceEndpoint } from "./runEvidenceTypes.js"

const CompletedKeys = [
    "kind",
    "saturatedEndpoints",
    "observedNonRequiredEndpoints",
    "evidence"
  ] as const,
  BreakageKeys = [
    ...CompletedKeys,
    "breakageCategory",
    "breakageReason"
  ] as const

/**
 * Parse one descriptor-safe generic deferred callback observation.
 * @param input Recursively snapshotted callback root candidate.
 * @param requiredEndpoints Canonical required endpoint ordering.
 * @param parseEvidence Flow-owned parser for the nested evidence payload.
 * @returns Exact generic completed or breakage observation.
 * @throws OppStressRampInvalidObservationError when root or evidence is invalid.
 */
export function parseOppStressRampDeferredEvidenceObservation<
  TEvidence extends object
>(
  input: unknown,
  requiredEndpoints: readonly RunEvidenceEndpoint[],
  parseEvidence: OppStressRampDeferredEvidenceParser<TEvidence>
): OppStressRampDeferredEvidenceIterationObservation<TEvidence> {
  const record = snapshotRampObservationVariantData(input, [
    CompletedKeys,
    BreakageKeys
  ])
  if (record === null)
    return invalid("value must be an exact completed or breakage variant")
  switch (record.kind) {
    case "completed":
      if (Reflect.ownKeys(record).length !== CompletedKeys.length)
        return invalid("completed observation has breakage fields")
      return completedObservation(record, requiredEndpoints, parseEvidence)
    case "breakage":
      if (Reflect.ownKeys(record).length !== BreakageKeys.length)
        return invalid("breakage observation is missing classification fields")
      return breakageObservation(record, requiredEndpoints, parseEvidence)
    default:
      return invalid("kind must be completed or breakage")
  }
}

function completedObservation<TEvidence extends object>(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[],
  parseEvidence: OppStressRampDeferredEvidenceParser<TEvidence>
): OppStressRampDeferredEvidenceCompletedObservation<TEvidence> {
  const saturatedEndpoints = parseSaturatedEndpoints(
    record.saturatedEndpoints,
    requiredEndpoints
  )
  return {
    kind: "completed",
    saturatedEndpoints,
    observedNonRequiredEndpoints: parseDiagnosticEndpoints(
      record.observedNonRequiredEndpoints,
      requiredEndpoints
    ),
    evidence: parsedEvidence(
      record.evidence,
      { kind: "completed", saturatedEndpoints },
      parseEvidence
    )
  }
}

function breakageObservation<TEvidence extends object>(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[],
  parseEvidence: OppStressRampDeferredEvidenceParser<TEvidence>
): OppStressRampDeferredEvidenceBreakageObservation<TEvidence> {
  if (!isBreakageCategory(record.breakageCategory))
    return invalid("breakageCategory is unknown")
  if (!isNonEmptyString(record.breakageReason))
    return invalid("breakageReason must be a non-empty string")
  const saturatedEndpoints = parseSaturatedEndpoints(
      record.saturatedEndpoints,
      requiredEndpoints
    ),
    context = {
      kind: "breakage" as const,
      breakageCategory: record.breakageCategory,
      saturatedEndpoints
    }
  return {
    kind: "breakage",
    saturatedEndpoints,
    observedNonRequiredEndpoints: parseDiagnosticEndpoints(
      record.observedNonRequiredEndpoints,
      requiredEndpoints
    ),
    breakageCategory: record.breakageCategory,
    breakageReason: record.breakageReason,
    evidence: parsedEvidence(record.evidence, context, parseEvidence)
  }
}

function parsedEvidence<TEvidence extends object>(
  input: unknown,
  context: OppStressRampDeferredEvidenceParseContext,
  parseEvidence: OppStressRampDeferredEvidenceParser<TEvidence>
): TEvidence {
  try {
    const evidence = parseEvidence(input, context)
    return evidence ?? invalid("evidence parser returned null")
  } catch {
    return invalid("evidence parser rejected the snapshotted payload")
  }
}

function invalid(reason: string): never {
  throw new OppStressRampInvalidObservationError(reason)
}
