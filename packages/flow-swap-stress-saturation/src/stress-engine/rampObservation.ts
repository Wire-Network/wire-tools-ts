import type {
  OppStressRampDeferredBreakageObservation,
  OppStressRampDeferredCompletedObservation,
  OppStressRampDeferredIterationObservation,
  OppStressRampObservationFields
} from "./rampControllerTypes.js"
import {
  RunEvidenceEndpoints,
  type RunEvidenceEndpoint
} from "./runEvidenceTypes.js"
import {
  hasUniqueStrings,
  isBreakageCategory,
  isNonEmptyString,
  isNonNegativeSafeInteger
} from "./run-evidence/runEvidencePrimitiveGuards.js"
import {
  snapshotRampObservationData,
  type RampObservationRecord
} from "./rampObservationSnapshot.js"

/** Exact top-level keys for the temporary deferred completed observation. */
export const DeferredCompletedObservationKeys = [
  "kind",
  "phase",
  "observationStartedAtMs",
  "observationEndedAtMs",
  "txSuccesses",
  "txFailures",
  "envelopeCount",
  "envelopeByteSizes",
  "endpoint",
  "epochStart",
  "epochEnd",
  "saturatedEndpoints",
  "observedNonRequiredEndpoints"
] as const

/** Exact top-level keys for the temporary deferred breakage observation. */
export const DeferredBreakageObservationKeys = [
  ...DeferredCompletedObservationKeys,
  "breakageCategory",
  "breakageReason"
] as const

/** Typed failure raised when a ramp callback violates the observation contract. */
export class OppStressRampInvalidObservationError extends Error {
  /** Stable error identity for logging and tests. */
  readonly name = "OppStressRampInvalidObservationError"

  /**
   * Create an invalid-observation failure.
   *
   * @param reason Contract rule violated by the callback value.
   */
  constructor(readonly reason: string) {
    super(`Invalid OPP stress ramp observation: ${reason}`)
  }
}

/**
 * Snapshot and validate endpoint labels required by one ramp campaign.
 *
 * @param input Untrusted required-endpoint input.
 * @returns Fresh endpoint array preserving caller order.
 */
export function parseOppStressRampRequiredEndpoints(
  input: unknown
): readonly RunEvidenceEndpoint[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    !input.every(isRunEvidenceEndpoint) ||
    !hasUniqueStrings(input)
  )
    return invalid("requiredEndpoints must contain unique canonical endpoints")
  return [...input]
}

/**
 * Parse and normalize one untrusted callback observation.
 *
 * @param input Callback value crossing the controller boundary.
 * @param requiredEndpoints Validated campaign endpoint snapshot.
 * @returns Fresh exact observation with stable-deduplicated diagnostics.
 */
export function parseOppStressRampDeferredIterationObservation(
  input: unknown,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampDeferredIterationObservation {
  const completedRecord = snapshotRampObservationData(
    input,
    DeferredCompletedObservationKeys
  )
  if (completedRecord?.kind === "completed")
    return completedObservation(completedRecord, requiredEndpoints)
  const breakageRecord = snapshotRampObservationData(
    input,
    DeferredBreakageObservationKeys
  )
  if (breakageRecord?.kind === "breakage")
    return breakageObservation(breakageRecord, requiredEndpoints)
  return invalid("value must be an exact completed or breakage variant")
}

function completedObservation(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampDeferredCompletedObservation {
  return {
    kind: "completed",
    ...parseOppStressRampObservationFields(record, requiredEndpoints)
  }
}

function breakageObservation(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampDeferredBreakageObservation {
  if (!isBreakageCategory(record.breakageCategory))
    return invalid("breakageCategory is unknown")
  if (!isNonEmptyString(record.breakageReason))
    return invalid("breakageReason must be a non-empty string")
  return {
    kind: "breakage",
    ...parseOppStressRampObservationFields(record, requiredEndpoints),
    breakageCategory: record.breakageCategory,
    breakageReason: record.breakageReason
  }
}

/** Parse shared Todo13 observation fields from a safe exact snapshot. */
export function parseOppStressRampObservationFields(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampObservationFields {
  if (!isNonEmptyString(record.phase))
    return invalid("phase must be a non-empty string")
  if (!isObservationTimestamp(record.observationStartedAtMs))
    return invalid("observationStartedAtMs must be a non-negative integer")
  if (!isObservationTimestamp(record.observationEndedAtMs))
    return invalid("observationEndedAtMs must be a non-negative integer")
  if (record.observationStartedAtMs > record.observationEndedAtMs)
    return invalid("observation timestamp window must be ordered")
  if (!isNonNegativeSafeInteger(record.txSuccesses))
    return invalid("txSuccesses must be a non-negative safe integer")
  if (!isNonNegativeSafeInteger(record.txFailures))
    return invalid("txFailures must be a non-negative safe integer")
  if (!isNonNegativeSafeInteger(record.envelopeCount))
    return invalid("envelopeCount must be a non-negative safe integer")
  if (
    !Array.isArray(record.envelopeByteSizes) ||
    !record.envelopeByteSizes.every(isNonNegativeSafeInteger) ||
    record.envelopeByteSizes.length !== record.envelopeCount
  )
    return invalid("envelopeByteSizes must match envelopeCount")
  if (!isNonEmptyString(record.endpoint))
    return invalid("endpoint must be a non-empty string")
  if (!isNonNegativeSafeInteger(record.epochStart))
    return invalid("epochStart must be a non-negative safe integer")
  if (!isNonNegativeSafeInteger(record.epochEnd))
    return invalid("epochEnd must be a non-negative safe integer")
  if (record.epochStart > record.epochEnd)
    return invalid("epoch window must be ordered")
  const saturatedEndpoints = parseSaturatedEndpoints(
      record.saturatedEndpoints,
      requiredEndpoints
    ),
    observedNonRequiredEndpoints = parseDiagnosticEndpoints(
      record.observedNonRequiredEndpoints,
      requiredEndpoints
    )
  return {
    phase: record.phase,
    observationStartedAtMs: record.observationStartedAtMs,
    observationEndedAtMs: record.observationEndedAtMs,
    txSuccesses: record.txSuccesses,
    txFailures: record.txFailures,
    envelopeCount: record.envelopeCount,
    envelopeByteSizes: [...record.envelopeByteSizes],
    endpoint: record.endpoint,
    epochStart: record.epochStart,
    epochEnd: record.epochEnd,
    saturatedEndpoints,
    observedNonRequiredEndpoints
  }
}

/**
 * Parse exact required endpoint saturation claims.
 * @param value Unknown endpoint collection from a safe snapshot.
 * @param requiredEndpoints Canonical allowed endpoint collection.
 * @returns Ordered unique saturation claims.
 */
export function parseSaturatedEndpoints(
  input: unknown,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): readonly RunEvidenceEndpoint[] {
  if (
    !Array.isArray(input) ||
    !input.every(isRunEvidenceEndpoint) ||
    !hasUniqueStrings(input) ||
    !input.every(endpoint => requiredEndpoints.includes(endpoint))
  )
    return invalid("saturatedEndpoints must be a unique required subset")
  return [...input]
}

/**
 * Parse exact non-required diagnostic endpoint labels.
 * @param value Unknown diagnostic collection from a safe snapshot.
 * @param requiredEndpoints Endpoint labels forbidden as diagnostics.
 * @returns First-occurrence-ordered diagnostic labels.
 */
export function parseDiagnosticEndpoints(
  input: unknown,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): readonly string[] {
  if (
    !Array.isArray(input) ||
    !input.every(isNonEmptyString) ||
    input.some(endpoint =>
      requiredEndpoints.some(required => required === endpoint)
    )
  )
    return invalid("diagnostic endpoints must be non-empty and non-required")
  return [...new Set(input)]
}

function isObservationTimestamp(value: unknown): value is number | bigint {
  return (
    (typeof value === "number" && isNonNegativeSafeInteger(value)) ||
    (typeof value === "bigint" && value >= 0n)
  )
}

function isRunEvidenceEndpoint(value: unknown): value is RunEvidenceEndpoint {
  return (
    typeof value === "string" &&
    RunEvidenceEndpoints.some(endpoint => endpoint === value)
  )
}

function invalid(reason: string): never {
  throw new OppStressRampInvalidObservationError(reason)
}
