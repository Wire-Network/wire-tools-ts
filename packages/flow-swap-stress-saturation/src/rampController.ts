import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { runOppStressRamp } from "@wireio/test-opp-stress"
import type { OppStressRampEvidence } from "@wireio/test-opp-stress"

import { StressRampDefaults } from "./rampControllerTypes.js"
import type {
  StressRampEvidence,
  StressRampOptions,
  StressRampResult
} from "./rampControllerTypes.js"

export { StressRampDefaults } from "./rampControllerTypes.js"
export type {
  StressRampConfig,
  StressRampEvidence,
  StressRampIterationInput,
  StressRampIterationOutcome,
  StressRampOptions,
  StressRampResult
} from "./rampControllerTypes.js"

/**
 * Run stress iterations until both Ethereum OPP directions saturate, breakage, or max count.
 *
 * @param options Evidence directory, ramp config, and iteration runner.
 * @returns Final ramp status plus in-memory evidence records.
 */
export async function runSaturationRamp(
  options: StressRampOptions
): Promise<StressRampResult> {
  const result = await runOppStressRamp({
    ...options,
    config: options.config ?? defaultRampConfig(),
    requiredEndpoints: requiredEndpointNames()
  })
  return {
    ...result,
    iterations: result.iterations.map(flowEvidence)
  }
}

function defaultRampConfig(): NonNullable<StressRampOptions["config"]> {
  return {
    initialCount: StressRampDefaults.InitialCount,
    multiplier: StressRampDefaults.Multiplier,
    maxCount: StressRampDefaults.MaxCount,
    phaseTimeoutMs: StressRampDefaults.PhaseTimeoutMs
  }
}

function requiredEndpointNames(): readonly string[] {
  return [
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT],
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM]
  ]
}

function flowEvidence(evidence: OppStressRampEvidence): StressRampEvidence {
  return {
    ...evidence,
    startedAtMs: Number(evidence.startedAtMs),
    endedAtMs: Number(evidence.endedAtMs)
  }
}
