/** Default OPP stress ramp constants for local e2e runs. */
export namespace OppStressRampDefaults {
  /** First account count in a stress ramp. */
  export const InitialCount = 8
  /** Account-count multiplier between non-saturating iterations. */
  export const Multiplier = 2
  /** Safety cap that bounds a stress campaign. */
  export const MaxCount = 512
  /** Per-phase timeout metadata persisted into evidence. */
  export const PhaseTimeoutMs = 480_000
}

/** Immutable OPP stress ramp configuration. */
export type OppStressRampConfig = {
  /** First account count to run. */
  readonly initialCount: number
  /** Multiplier applied after each non-saturating iteration. */
  readonly multiplier: number
  /** Maximum account count before reporting incomplete saturation. */
  readonly maxCount: number
  /** Per-phase timeout carried into evidence metadata. */
  readonly phaseTimeoutMs: number
}

/** Input passed to the caller's OPP workload iteration runner. */
export type OppStressRampIterationInput = {
  /** Zero-based iteration index. */
  readonly iterationIndex: number
  /** Account or request count for this iteration. */
  readonly accountCount: number
  /** Per-phase timeout selected by the ramp config. */
  readonly phaseTimeoutMs: number
}

/** Metrics and classification returned by one OPP stress iteration. */
export type OppStressRampIterationOutcome = {
  /** Iteration classification before campaign aggregation. */
  readonly kind: "not_saturated" | "saturated" | "breakage"
  /** Zero-based iteration index. */
  readonly iterationIndex: number
  /** Account or request count used by this iteration. */
  readonly accountCount: number
  /** Workload phase that produced the final metrics. */
  readonly phase: string
  /** Iteration start timestamp in Unix milliseconds. */
  readonly startedAtMs: number | bigint
  /** Iteration end timestamp in Unix milliseconds. */
  readonly endedAtMs: number | bigint
  /** Successful transaction count across the measured phase. */
  readonly txSuccesses: number
  /** Failed transaction count across the measured phase. */
  readonly txFailures: number
  /** Breakage reason when kind is breakage. */
  readonly breakageReason?: string | null
  /** Matching OPP envelope count for the phase window. */
  readonly envelopeCount: number
  /** Matching OPP envelope byte sizes. */
  readonly envelopeByteSizes: readonly number[]
  /** Endpoint direction label persisted for evidence readers. */
  readonly endpoint: string
  /** Inclusive epoch lower bound for the metrics window. */
  readonly epochStart: number
  /** Inclusive epoch upper bound for the metrics window. */
  readonly epochEnd: number
  /** Required endpoints saturated by this iteration. */
  readonly saturatedEndpoints?: readonly string[]
  /** Required endpoints the iteration still reports as missing. */
  readonly missingEndpoints?: readonly string[]
  /** Non-required endpoints observed as diagnostics only. */
  readonly observedNonRequiredEndpoints?: readonly string[]
}

/** Persisted evidence for one OPP stress ramp iteration. */
export type OppStressRampEvidence = OppStressRampIterationOutcome & {
  /** Finalized status for this iteration's evidence file. */
  readonly status: OppStressRampResultStatus | "running" | "not_saturated"
  /** Whether the caller must retain cluster artifacts after this outcome. */
  readonly preserveCluster: boolean
  /** Ramp constants active for this run. */
  readonly config: OppStressRampConfig
  /** Required endpoints saturated across the campaign so far. */
  readonly saturatedEndpoints: readonly string[]
  /** Required endpoints still missing across the campaign so far. */
  readonly missingEndpoints: readonly string[]
  /** Non-required endpoints observed as diagnostic saturation across the campaign. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Final OPP stress campaign status. */
export type OppStressRampResultStatus =
  | "saturated"
  | "partial_saturation"
  | "failed_before_saturation"
  | "saturation_not_reached"

/** Final ramp result returned to an e2e flow. */
export type OppStressRampResult = {
  /** Final run status. */
  readonly status: OppStressRampResultStatus
  /** Whether cluster artifacts must be preserved by teardown. */
  readonly preserveCluster: boolean
  /** Iterations executed before the controller stopped. */
  readonly iterations: readonly OppStressRampEvidence[]
  /** Required endpoints saturated across the campaign. */
  readonly saturatedEndpoints: readonly string[]
  /** Required endpoints still missing at final status. */
  readonly missingEndpoints: readonly string[]
  /** Non-required endpoints observed as diagnostic saturation across the campaign. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Options for the OPP stress saturation ramp controller. */
export type OppStressRampOptions = {
  /** Directory where per-iteration JSON evidence files are written. */
  readonly evidenceDir: string
  /** Required OPP endpoint labels that must saturate for campaign success. */
  readonly requiredEndpoints: readonly string[]
  /** Ramp constants. */
  readonly config?: OppStressRampConfig
  /** Real or synthetic iteration runner. */
  readonly runIteration: (
    input: OppStressRampIterationInput
  ) => Promise<OppStressRampIterationOutcome>
}
