import {
  RampBreakageCategory,
  type OppStressRampObservationFields
} from "@wireio/test-opp-stress"

import type { SwapStressIterationObservation } from "./phaseRunnerTypes.js"

type CompatibilityFields = Omit<
  OppStressRampObservationFields,
  "saturatedEndpoints" | "observedNonRequiredEndpoints"
>

/** Project legacy scalar fields without requiring measured workload evidence. */
export function flowRunObservationCompatibility(
  observation: SwapStressIterationObservation
): CompatibilityFields {
  const measured = observation.evidence.phaseResults.filter(
      result => result.measurement !== "unmeasured"
    ),
    first = measured[0],
    last = measured.at(-1)
  if (first === undefined || last === undefined)
    return emptyCompatibilityFields(observation)
  return {
    phase: last.phase,
    observationStartedAtMs: first.observationStartedAtMs,
    observationEndedAtMs: last.observationEndedAtMs,
    txSuccesses: measured.reduce((sum, result) => sum + result.txSuccesses, 0),
    txFailures: measured.reduce((sum, result) => sum + result.txFailures, 0),
    envelopeCount: measured.reduce((sum, result) => sum + result.envelopeCount, 0),
    envelopeByteSizes: measured.flatMap(result => result.envelopeByteSizes),
    endpoint: last.endpoint,
    epochStart: Number(first.epochStart),
    epochEnd: Number(last.epochEnd)
  }
}

function emptyCompatibilityFields(
  observation: SwapStressIterationObservation
): CompatibilityFields {
  if (observation.kind !== "breakage")
    throw new TypeError("completed flow observation requires measured phase evidence")
  const label = breakageLabel(observation.breakageCategory)
  return {
    phase: label,
    observationStartedAtMs: 0,
    observationEndedAtMs: 0,
    txSuccesses: 0,
    txFailures: 0,
    envelopeCount: 0,
    envelopeByteSizes: [],
    endpoint: label,
    epochStart: 0,
    epochEnd: 0
  }
}

function breakageLabel(
  category:
    | RampBreakageCategory.Workload
    | RampBreakageCategory.TelemetryIntegrity
): string {
  switch (category) {
    case RampBreakageCategory.Workload:
      return "workload"
    case RampBreakageCategory.TelemetryIntegrity:
      return "telemetry"
    default:
      return assertNever(category)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected flow breakage category: ${String(value)}`)
}
