import type {
  OppStressRampConfig,
  OppStressRampDeferredEvidenceResult,
  OppStressRampDeferredEvidenceSummary,
  OppStressRampIterationInput,
  RunEvidencePersistence
} from "@wireio/test-opp-stress"
import type {
  SwapStressIterationObservation,
  SwapStressObservationEvidence
} from "./phaseRunnerTypes.js"

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

/** Typed controller summary for one flow iteration. */
export type StressRampEvidence =
  OppStressRampDeferredEvidenceSummary<SwapStressObservationEvidence>

/** Final ramp result returned to the future e2e flow. */
export type StressRampResult =
  OppStressRampDeferredEvidenceResult<SwapStressObservationEvidence>

/** Options for the saturation ramp controller. */
export type StressRampOptions = {
  /** Optional flow ramp configuration. */
  readonly config?: StressRampConfig
  /** Controller lifecycle clock. */
  readonly clock?: () => number
  /** Canonical schema-v1 publication authority for the real flow. */
  readonly persistence?: RunEvidencePersistence
  /** Observation-only real or synthetic iteration runner. */
  readonly runIteration: (
    input: StressRampIterationInput
  ) => Promise<SwapStressIterationObservation>
}
