import type { CanonicalRampDecision } from "./rampDecision.js"
import type {
  OppStressRampDeferredEvidenceIterationObservation,
  OppStressRampDeferredEvidenceSummary
} from "./rampDeferredEvidenceTypes.js"
import { mergeRampDiagnostics } from "./rampIterationSummary.js"
import type { OppStressRampConfig } from "./rampControllerTypes.js"
import type { OppStressRampResultStatus } from "./rampControllerTypes.js"
import { RunEvidenceIterationOutcome } from "./runEvidenceTypes.js"
import type { RunEvidenceEndpoint } from "./runEvidenceTypes.js"

/** Generic deferred state needed to stamp one controller-owned summary. */
export type DeferredEvidenceSummaryState = {
  readonly iterationIndex: number
  readonly accountCount: number
  readonly observedNonRequiredEndpoints: readonly string[]
}

/**
 * Build one generic callback-backed or boundary-failure iteration summary.
 * @param observation Parsed generic observation, or null at a failed boundary.
 * @param decision Canonical controller decision for the iteration.
 * @param config Validated ramp configuration.
 * @param state Controller-owned iteration identity and prior diagnostics.
 * @returns Typed generic deferred summary.
 */
export function deferredEvidenceIterationSummary<TEvidence extends object>(
  observation: OppStressRampDeferredEvidenceIterationObservation<TEvidence> | null,
  decision: CanonicalRampDecision,
  config: OppStressRampConfig,
  state: DeferredEvidenceSummaryState
): OppStressRampDeferredEvidenceSummary<TEvidence> {
  const observedNonRequiredEndpoints =
      observation === null
        ? state.observedNonRequiredEndpoints
        : mergeRampDiagnostics(
            state.observedNonRequiredEndpoints,
            observation.observedNonRequiredEndpoints
          ),
    fields: {
      readonly iterationIndex: number
      readonly accountCount: number
      readonly startedAtMs: number
      readonly endedAtMs: number
      readonly status: OppStressRampResultStatus | "not_saturated"
      readonly preserveCluster: boolean
      readonly config: OppStressRampConfig
      readonly saturatedEndpoints: readonly RunEvidenceEndpoint[]
      readonly missingEndpoints: readonly RunEvidenceEndpoint[]
      readonly observedNonRequiredEndpoints: readonly string[]
    } = {
      iterationIndex: state.iterationIndex,
      accountCount: state.accountCount,
      startedAtMs: decision.controllerStartedAtMs,
      endedAtMs: decision.controllerEndedAtMs,
      status: decision.status ?? "not_saturated",
      preserveCluster: decision.preserveCluster,
      config,
      saturatedEndpoints: decision.saturatedEndpoints,
      missingEndpoints: decision.missingEndpoints,
      observedNonRequiredEndpoints
    }
  if (observation === null) {
    if (decision.kind !== "failed")
      throw new TypeError("Controller failure requires a failed decision")
    return {
      ...fields,
      kind: "breakage",
      observation: null,
      breakageCategory: decision.breakageCategory,
      breakageReason: decision.breakageReason,
      telemetry: decision.schemaEvidence.telemetry,
      cause: decision.cause
    }
  }
  if (observation.kind === "breakage") {
    if (decision.kind !== "failed")
      throw new TypeError("Breakage observation requires a failed decision")
    return {
      ...fields,
      kind: "breakage",
      observation,
      breakageCategory: decision.breakageCategory,
      breakageReason: decision.breakageReason
    }
  }
  return {
    ...fields,
    kind:
      decision.outcome === RunEvidenceIterationOutcome.Saturated
        ? "saturated"
        : "not_saturated",
    observation
  }
}
