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
export type StressRampConfig = {
  /** First account count to run. */
  readonly initialCount: number
  /** Multiplier applied after each non-saturating iteration. */
  readonly multiplier: number
  /** Maximum account count before reporting saturation_not_reached. */
  readonly maxCount: number
  /** Per-phase timeout carried into evidence metadata. */
  readonly phaseTimeoutMs: number
}

/** Input passed to the caller's real or synthetic iteration runner. */
export type StressRampIterationInput = {
  /** Zero-based iteration index. */
  readonly iterationIndex: number
  /** Account count for this iteration. */
  readonly accountCount: number
  /** Per-phase timeout selected by the ramp config. */
  readonly phaseTimeoutMs: number
}

/** Metrics and classification returned by one stress iteration. */
export type StressRampIterationOutcome = {
  /** Iteration classification before the controller applies final status. */
  readonly kind: "not_saturated" | "saturated" | "breakage"
  /** Zero-based iteration index. */
  readonly iterationIndex: number
  /** Account count used by this iteration. */
  readonly accountCount: number
  /** Stress phase that produced the metrics. */
  readonly phase: string
  /** Iteration start timestamp in Unix milliseconds. */
  readonly startedAtMs: number
  /** Iteration end timestamp in Unix milliseconds. */
  readonly endedAtMs: number
  /** Successful transaction count across the measured phase. */
  readonly txSuccesses: number
  /** Failed transaction count across the measured phase. */
  readonly txFailures: number
  /** Breakage reason when kind is breakage, otherwise null or omitted. */
  readonly breakageReason?: string | null
  /** Matching envelope count for the phase window. */
  readonly envelopeCount: number
  /** Matching envelope byte sizes. */
  readonly envelopeByteSizes: readonly number[]
  /** Endpoint direction label persisted for evidence readers. */
  readonly endpoint: string
  /** Inclusive epoch lower bound for the metrics window. */
  readonly epochStart: number
  /** Inclusive epoch upper bound for the metrics window. */
  readonly epochEnd: number
  /** Required Ethereum endpoints saturated by this iteration. */
  readonly saturatedEndpoints?: readonly string[]
  /** Required Ethereum endpoints missing after this iteration. */
  readonly missingEndpoints?: readonly string[]
  /** Non-required saturated endpoints observed as diagnostics only. */
  readonly observedNonRequiredEndpoints?: readonly string[]
}

/** Persisted evidence for one ramp iteration. */
export type StressRampEvidence = StressRampIterationOutcome & {
  /** Finalized status for this iteration's evidence file. */
  readonly status:
    | "running"
    | "not_saturated"
    | "saturated"
    | "partial_saturation"
    | "failed_before_saturation"
    | "saturation_not_reached"
  /** Whether the caller must retain cluster artifacts after this outcome. */
  readonly preserveCluster: boolean
  /** Ramp constants active for this run. */
  readonly config: StressRampConfig
}

/** Final ramp result returned to the future e2e flow. */
export type StressRampResult = {
  /** Final run status. */
  readonly status:
    | "saturated"
    | "partial_saturation"
    | "failed_before_saturation"
    | "saturation_not_reached"
  /** Whether cluster artifacts must be preserved by teardown. */
  readonly preserveCluster: boolean
  /** Iterations executed before the controller stopped. */
  readonly iterations: readonly StressRampEvidence[]
  /** Required Ethereum endpoints saturated across the campaign. */
  readonly saturatedEndpoints: readonly string[]
  /** Required Ethereum endpoints still missing at final status. */
  readonly missingEndpoints: readonly string[]
  /** Non-required endpoints observed as diagnostic saturation across the campaign. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Options for the saturation ramp controller. */
export type StressRampOptions = {
  /** Directory where per-iteration JSON evidence files are written. */
  readonly evidenceDir: string
  /** Ramp constants. */
  readonly config?: StressRampConfig
  /** Real or synthetic iteration runner. */
  readonly runIteration: (
    input: StressRampIterationInput
  ) => Promise<StressRampIterationOutcome>
}
