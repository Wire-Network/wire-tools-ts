import {
  OppEnvelopeTelemetryHealthKind,
  type DegradedOppEnvelopeTelemetryHealth
} from "./envelopeMetricTypes.js"
import { snapshotRampObservationData } from "./rampObservationSnapshot.js"
import {
  OppEnvelopeTelemetryHealthParseError,
  parseOppEnvelopeTelemetryHealth
} from "./telemetryHealth.js"

const TelemetryHealthKeys = [
  "kind",
  "retryable",
  "candidateCount",
  "validCount",
  "filteredCount",
  "issueCount",
  "issues"
] as const

const TelemetryIntegrityErrors = new WeakSet<object>()

/** Typed callback failure carrying an immutable parser-valid degraded snapshot. */
export class OppStressRampTelemetryIntegrityError extends Error {
  /** Stable error identity for callback-boundary classification. */
  readonly name = "OppStressRampTelemetryIntegrityError"
  /** Detached degraded telemetry safe for persisted evidence. */
  readonly telemetry: DegradedOppEnvelopeTelemetryHealth

  /**
   * Create a telemetry-integrity callback failure.
   *
   * @param message Stable failure reason.
   * @param telemetry Untrusted degraded telemetry to snapshot and parse.
   */
  constructor(message: string, telemetry: unknown) {
    const snapshot = snapshotRampObservationData(
        telemetry,
        TelemetryHealthKeys
      ),
      parsed = parseOppEnvelopeTelemetryHealth(snapshot)
    if (parsed.kind !== OppEnvelopeTelemetryHealthKind.Degraded)
      throw new OppEnvelopeTelemetryHealthParseError(
        "health.kind",
        "ramp telemetry-integrity error requires degraded health"
      )
    super(message)
    freezeTelemetry(parsed, new WeakSet())
    this.telemetry = parsed
    TelemetryIntegrityErrors.add(this)
    Object.freeze(this)
  }
}

/**
 * Identify only telemetry-integrity errors created by this module.
 * @param value Untrusted callback rejection value.
 * @returns Whether the value carries the module-private error brand.
 */
export function isOppStressRampTelemetryIntegrityError(
  value: unknown
): value is OppStressRampTelemetryIntegrityError {
  return (
    typeof value === "object" &&
    value !== null &&
    TelemetryIntegrityErrors.has(value)
  )
}

function freezeTelemetry(value: object, visited: WeakSet<object>): void {
  if (visited.has(value)) return
  visited.add(value)
  Reflect.ownKeys(value).forEach(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, "value") &&
      typeof descriptor.value === "object" &&
      descriptor.value !== null
    )
      freezeTelemetry(descriptor.value, visited)
  })
  Object.freeze(value)
}
