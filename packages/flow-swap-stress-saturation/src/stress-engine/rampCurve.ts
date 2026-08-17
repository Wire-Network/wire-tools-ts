/**
 * The ramp's account curve: its shape, its defaults, and its validation.
 *
 * This is the whole of what survives the ramp controller. The controller
 * itself — the imperative loop that walked the curve and decided when to stop
 * — is gone: the campaign now registers one Phase per rung at plan time, so
 * the curve is a static input rather than something discovered at run time.
 */

/** Default ramp bounds for a local stress run. */
export namespace OppStressRampDefaults {
  /** First account count in a stress ramp. */
  export const InitialCount = 8
  /** Account-count multiplier between non-saturating iterations. */
  export const Multiplier = 2
  /** Safety cap that bounds a stress campaign. */
  export const MaxCount = 512
  /** Per-phase deadline applied to each rung's Steps. */
  export const PhaseTimeoutMs = 480_000
}

/** Immutable OPP stress ramp configuration. */
export interface OppStressRampConfig {
  /** Account count submitted by the first ramp rung. */
  readonly initialCount: number
  /** Multiplicative account-count increase between rungs. */
  readonly multiplier: number
  /** Inclusive maximum account count the curve may reach. */
  readonly maxCount: number
  /** Deadline in milliseconds for each workload phase. */
  readonly phaseTimeoutMs: number
}

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
 * @param config Ramp config to validate before the curve is walked.
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
