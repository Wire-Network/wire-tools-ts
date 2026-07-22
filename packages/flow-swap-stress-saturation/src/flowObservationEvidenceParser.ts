import {
  RampBreakageCategory,
  type RunEvidenceEndpoint,
  type OppStressRampDeferredEvidenceParseContext
} from "@wireio/test-opp-stress"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { classifyEthereumAllLegsSaturation } from "./ethereumAllLegsClassification.js"
import type { SwapStressPhaseResult } from "./phaseRunnerMetricTypes.js"
import type { SwapStressObservationEvidence } from "./phaseRunnerTypes.js"
import {
  hasExactObservationKeys,
  isObservationRecord,
  observationValuesEqual
} from "./flowObservationParserSupport.js"
import { isSwapStressPhaseResult } from "./flowPhaseResultParser.js"
import { isSwapStressTelemetryDegradation } from "./flowTelemetryDegradationParser.js"

/**
 * Parse exact recursively snapshotted flow evidence for generic deferred mode.
 * @param input Unknown flow evidence candidate.
 * @param context Parsed generic root discriminant and breakage category.
 * @returns Typed coherent flow evidence, or null for invalid data.
 */
export function parseSwapStressObservationEvidence(
  input: unknown,
  context: OppStressRampDeferredEvidenceParseContext
): SwapStressObservationEvidence | null {
  if (
    !isObservationRecord(input) ||
    !hasExactObservationKeys(input, ["phaseResults", "telemetryDegradation"]) ||
    !Array.isArray(input.phaseResults) ||
    !input.phaseResults.every(isSwapStressPhaseResult) ||
    !hasCoherentSaturation(input.phaseResults, context.saturatedEndpoints)
  )
    return null
  switch (context.kind) {
    case "completed":
      return input.telemetryDegradation === null
        ? {
            phaseResults: [...input.phaseResults],
            telemetryDegradation: null
          }
        : null
    case "breakage":
      switch (context.breakageCategory) {
        case RampBreakageCategory.Workload:
          return input.telemetryDegradation === null
            ? {
                phaseResults: [...input.phaseResults],
                telemetryDegradation: null
              }
            : null
        case RampBreakageCategory.TelemetryIntegrity:
          return isSwapStressTelemetryDegradation(input.telemetryDegradation)
            ? {
                phaseResults: [...input.phaseResults],
                telemetryDegradation: input.telemetryDegradation
              }
            : null
        case RampBreakageCategory.InvalidObservation:
        case RampBreakageCategory.Infrastructure:
          return null
        default:
          return assertNever(context.breakageCategory)
      }
    default:
      return assertNever(context)
  }
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
