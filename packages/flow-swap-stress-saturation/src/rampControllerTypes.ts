import type {
  OppStressRampConfig,
  OppStressRampEvidence,
  OppStressRampIterationInput,
  OppStressRampIterationOutcome,
  OppStressRampOptions,
  OppStressRampResult
} from "@wireio/test-opp-stress"

/** Default ramp constants for local stress saturation runs. */
export namespace StressRampDefaults {
  /** First account count in a real stress ramp. */
  export const InitialCount = 8
  /** Aggressive account-count multiplier between iterations. */
  export const Multiplier = 2
  /** Safety cap that prevents an accidental infinite stress loop. */
  export const MaxCount = 512
  /** Per-phase timeout metadata persisted into evidence. */
  export const PhaseTimeoutMs = 480_000
  /** Tiny fixture byte count used only by unit-test evidence. */
  export const EvidenceFixtureBytes = 128
}

/** Immutable ramp configuration. */
export type StressRampConfig = OppStressRampConfig

/** Input passed to the caller's real or synthetic iteration runner. */
export type StressRampIterationInput = OppStressRampIterationInput

/** Metrics and classification returned by one stress iteration. */
export type StressRampIterationOutcome = Omit<
  OppStressRampIterationOutcome,
  "startedAtMs" | "endedAtMs"
> & {
  /** Iteration start timestamp in Unix milliseconds. */
  readonly startedAtMs: number
  /** Iteration end timestamp in Unix milliseconds. */
  readonly endedAtMs: number
}

/** Persisted evidence for one ramp iteration. */
export type StressRampEvidence = Omit<
  OppStressRampEvidence,
  "startedAtMs" | "endedAtMs"
> & {
  /** Iteration start timestamp in Unix milliseconds. */
  readonly startedAtMs: number
  /** Iteration end timestamp in Unix milliseconds. */
  readonly endedAtMs: number
}

/** Final ramp result returned to the future e2e flow. */
export type StressRampResult = Omit<OppStressRampResult, "iterations"> & {
  /** Iterations executed before the controller stopped. */
  readonly iterations: readonly StressRampEvidence[]
}

/** Options for the saturation ramp controller. */
export type StressRampOptions = Omit<
  OppStressRampOptions,
  "requiredEndpoints" | "runIteration"
> & {
  /** Real or synthetic iteration runner. */
  readonly runIteration: (
    input: StressRampIterationInput
  ) => Promise<StressRampIterationOutcome>
}
