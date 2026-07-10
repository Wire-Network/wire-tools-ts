import { OppStressRampDefaults } from "./rampControllerTypes.js"
import type { OppStressRampConfig } from "./rampControllerTypes.js"

/**
 * Build the default OPP stress ramp configuration.
 *
 * @returns Default ramp counts and timeout metadata for local stress runs.
 */
export function defaultRampConfig(): OppStressRampConfig {
  return {
    initialCount: OppStressRampDefaults.InitialCount,
    multiplier: OppStressRampDefaults.Multiplier,
    maxCount: OppStressRampDefaults.MaxCount,
    phaseTimeoutMs: OppStressRampDefaults.PhaseTimeoutMs
  }
}

/**
 * Validate a caller-supplied OPP stress ramp configuration.
 *
 * @param config Ramp config to validate before execution.
 */
export function assertRampConfig(config: OppStressRampConfig): void {
  if (!positiveInteger(config.initialCount))
    throw new RangeError("initialCount must be positive")
  if (!positiveInteger(config.multiplier) || config.multiplier <= 1) {
    throw new RangeError("multiplier must be greater than 1")
  }
  if (
    !positiveInteger(config.maxCount) ||
    config.maxCount < config.initialCount
  ) {
    throw new RangeError(
      "maxCount must be greater than or equal to initialCount"
    )
  }
  if (!positiveInteger(config.phaseTimeoutMs))
    throw new RangeError("phaseTimeoutMs must be positive")
}

function positiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}
