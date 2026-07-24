import { OppEnvelopeTelemetryHealthKind } from "./envelopeMetricTypes.js"
import type {
  OppStressRampBreakageObservation,
  OppStressRampCompletedObservation,
  OppStressRampEndpointTelemetry,
  OppStressRampIterationObservation,
  OppStressRampObservationEvidence
} from "./rampControllerTypes.js"
import {
  DeferredCompletedObservationKeys,
  parseOppStressRampObservationFields
} from "./rampObservation.js"
import {
  snapshotRampObservationData,
  type RampObservationRecord
} from "./rampObservationSnapshot.js"
import {
  hasBreakageTelemetry,
  isBreakageCategory,
  isExactRecord,
  isNonEmptyString,
  isTelemetryHealth
} from "./run-evidence/runEvidenceGuards.js"
import { isPhases } from "./run-evidence/runEvidencePhaseGuards.js"
import {
  RunEvidencePhaseStatus,
  type RunEvidenceEndpoint
} from "./runEvidenceTypes.js"
import { OppStressRampInvalidObservationError } from "./rampObservation.js"

const SchemaCompletedObservationKeys = [
    ...DeferredCompletedObservationKeys,
    "phases",
    "endpointTelemetry",
    "telemetry"
  ],
  SchemaBreakageObservationKeys = [
    ...SchemaCompletedObservationKeys,
    "breakageCategory",
    "breakageReason"
  ]

/** Parse one exact rich callback observation for durable schema-v1 mode. */
export function parseOppStressRampSchemaObservation(
  input: unknown,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampIterationObservation {
  const completed = snapshotRampObservationData(
    input,
    SchemaCompletedObservationKeys
  )
  if (completed?.kind === "completed")
    return completedObservation(completed, requiredEndpoints)
  const breakage = snapshotRampObservationData(
    input,
    SchemaBreakageObservationKeys
  )
  if (breakage?.kind === "breakage")
    return breakageObservation(breakage, requiredEndpoints)
  return invalid(
    "value must be an exact schema-v1 completed or breakage variant"
  )
}

function completedObservation(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampCompletedObservation {
  const fields = parseOppStressRampObservationFields(record, requiredEndpoints),
    evidence = observationEvidence(record, requiredEndpoints, fields)
  if (
    evidence.phases.length === 0 ||
    !evidence.phases.every(
      phase => phase.status === RunEvidencePhaseStatus.Completed
    ) ||
    !evidence.endpointTelemetry.every(
      entry => entry.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy
    ) ||
    evidence.telemetry.kind !== OppEnvelopeTelemetryHealthKind.Healthy
  )
    return invalid("completed schema evidence must be nonempty and healthy")
  return { kind: "completed", ...fields, ...evidence }
}

function breakageObservation(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): OppStressRampBreakageObservation {
  if (!isBreakageCategory(record.breakageCategory))
    return invalid("breakageCategory is unknown")
  if (!isNonEmptyString(record.breakageReason))
    return invalid("breakageReason must be a non-empty string")
  const fields = parseOppStressRampObservationFields(record, requiredEndpoints),
    evidence = observationEvidence(record, requiredEndpoints, fields)
  if (!hasBreakageTelemetry(record.breakageCategory, evidence.telemetry))
    return invalid("breakage telemetry is incompatible with its category")
  return {
    kind: "breakage",
    ...fields,
    ...evidence,
    breakageCategory: record.breakageCategory,
    breakageReason: record.breakageReason
  }
}

function observationEvidence(
  record: RampObservationRecord,
  requiredEndpoints: readonly RunEvidenceEndpoint[],
  fields: ReturnType<typeof parseOppStressRampObservationFields>
): OppStressRampObservationEvidence {
  const phases = record.phases,
    endpointTelemetry = record.endpointTelemetry,
    telemetry = record.telemetry
  if (!isPhases(phases)) return invalid("phases are not schema-v1 valid")
  if (!isEndpointTelemetry(endpointTelemetry, requiredEndpoints))
    return invalid("endpointTelemetry must exactly match allocation order")
  if (!isTelemetryHealth(telemetry))
    return invalid("aggregate telemetry is not valid")
  const currentSaturated = requiredEndpoints.filter(endpoint =>
    phases.some(
      phase =>
        phase.status === RunEvidencePhaseStatus.Completed &&
        phase.endpoint === endpoint &&
        phase.metrics.saturated
    )
  )
  if (!sameEndpoints(fields.saturatedEndpoints, currentSaturated))
    return invalid("saturatedEndpoints must equal current completed phases")
  if (
    currentSaturated.some(endpoint => {
      const current = endpointTelemetry.find(
        entry => entry.endpoint === endpoint
      )
      return current?.telemetry.kind !== OppEnvelopeTelemetryHealthKind.Healthy
    })
  )
    return invalid("new saturation requires healthy endpoint telemetry")
  return {
    phases,
    endpointTelemetry,
    telemetry
  }
}

function isEndpointTelemetry(
  value: unknown,
  requiredEndpoints: readonly RunEvidenceEndpoint[]
): value is readonly OppStressRampEndpointTelemetry[] {
  return (
    Array.isArray(value) &&
    value.length === requiredEndpoints.length &&
    value.every(
      (entry, index) =>
        isExactRecord(entry, ["endpoint", "telemetry"]) &&
        entry.endpoint === requiredEndpoints[index] &&
        isTelemetryHealth(entry.telemetry)
    )
  )
}

function sameEndpoints(
  first: readonly RunEvidenceEndpoint[],
  second: readonly RunEvidenceEndpoint[]
): boolean {
  return (
    first.length === second.length &&
    first.every((endpoint, index) => endpoint === second[index])
  )
}

function invalid(reason: string): never {
  throw new OppStressRampInvalidObservationError(reason)
}
