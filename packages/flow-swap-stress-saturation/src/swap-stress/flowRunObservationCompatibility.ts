import { match } from "ts-pattern"

import {
  RampBreakageCategory,
  type OppStressRampObservationFields
} from "../stress-engine/index.js"

import type { SwapStressIterationObservation } from "./phaseRunnerTypes.js"

/**
 * The endpoint fields the legacy scalar projection drops. Declared as an
 * interface so the `Omit` key union below is DERIVED (`keyof`) rather than a
 * hand-written literal union.
 */
interface DroppedObservationEndpointFields {
  readonly saturatedEndpoints: OppStressRampObservationFields["saturatedEndpoints"]
  readonly observedNonRequiredEndpoints: OppStressRampObservationFields["observedNonRequiredEndpoints"]
}

type CompatibilityFields = Omit<
  OppStressRampObservationFields,
  keyof DroppedObservationEndpointFields
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
  return match(category)
    .with(RampBreakageCategory.Workload, () => "workload")
    .with(RampBreakageCategory.TelemetryIntegrity, () => "telemetry")
    .otherwise(value => assertNever(value))
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected flow breakage category: ${String(value)}`)
}
