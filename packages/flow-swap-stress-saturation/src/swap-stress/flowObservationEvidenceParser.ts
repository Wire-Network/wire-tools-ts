import { match } from "ts-pattern"

import {
  RampBreakageCategory,
  type RunEvidenceEndpoint,
  type OppStressRampDeferredEvidenceParseContext
} from "../stress-engine/index.js"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { classifyEthereumAllLegsSaturation } from "./ethereumAllLegsClassification.js"
import type { SwapStressPhaseResult } from "./phaseRunnerMetricTypes.js"
import type { SwapStressObservationEvidence } from "./phaseRunnerTypes.js"
import {
  hasExactObservationKeys,
  isObservationRecord,
  observationValuesEqual
} from "../observation-parsing/index.js"
import { isSwapStressPhaseResult } from "./flowPhaseResultParser.js"
import { isSwapStressTelemetryDegradation } from "./flowTelemetryDegradationParser.js"

/**
 * Parsed flow evidence, or `null` when the candidate is invalid. This package
 * compiles with `strictNullChecks`, so the nullable leg is a load-bearing part
 * of the contract and is named rather than spelled inline at the return
 * position.
 */
type ParsedSwapStressObservationEvidence = SwapStressObservationEvidence | null

/**
 * Parse exact recursively snapshotted flow evidence for generic deferred mode.
 * @param input Unknown flow evidence candidate.
 * @param context Parsed generic root discriminant and breakage category.
 * @returns Typed coherent flow evidence, or null for invalid data.
 */
export function parseSwapStressObservationEvidence(
  input: unknown,
  context: OppStressRampDeferredEvidenceParseContext
): ParsedSwapStressObservationEvidence {
  if (
    !isObservationRecord(input) ||
    !hasExactObservationKeys(input, ["phaseResults", "telemetryDegradation"]) ||
    !Array.isArray(input.phaseResults) ||
    !input.phaseResults.every(isSwapStressPhaseResult) ||
    !hasCoherentSaturation(input.phaseResults, context.saturatedEndpoints)
  )
    return null
  const phaseResults = input.phaseResults
  return match(context)
    .with({ kind: "completed" }, () =>
      input.telemetryDegradation === null
        ? {
            phaseResults: [...phaseResults],
            telemetryDegradation: null
          }
        : null
    )
    .with({ kind: "breakage" }, breakage =>
      match(breakage.breakageCategory)
        .with(RampBreakageCategory.Workload, () =>
          input.telemetryDegradation === null
            ? {
                phaseResults: [...phaseResults],
                telemetryDegradation: null
              }
            : null
        )
        .with(RampBreakageCategory.TelemetryIntegrity, () =>
          isSwapStressTelemetryDegradation(input.telemetryDegradation)
            ? {
                phaseResults: [...phaseResults],
                telemetryDegradation: input.telemetryDegradation
              }
            : null
        )
        .with(
          RampBreakageCategory.InvalidObservation,
          RampBreakageCategory.Infrastructure,
          () => null
        )
        .otherwise(value => assertNever(value))
    )
    .otherwise(value => assertNever(value))
}

function hasCoherentSaturation(
  phaseResults: readonly SwapStressPhaseResult[],
  saturatedEndpoints: readonly RunEvidenceEndpoint[]
): boolean {
  const evidenceEndpoints = classifyEthereumAllLegsSaturation(
    phaseResults
  ).saturatedEndpoints.map(endpoint => DebugOutpostEndpointsType[endpoint])
  return observationValuesEqual(evidenceEndpoints, saturatedEndpoints)
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected flow observation context: ${String(value)}`)
}
