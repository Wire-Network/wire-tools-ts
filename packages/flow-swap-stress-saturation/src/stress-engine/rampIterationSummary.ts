import type {
  CanonicalRampDecision,
  LegacyRampDecisionObservation
} from "./rampDecision.js"
import type { RampState } from "./rampControllerRuntime.js"
import type {
  OppStressRampConfig,
  OppStressRampEvidence
} from "./rampControllerTypes.js"

/** Build the flow-compatible summary exclusively from the canonical decision. */
export function rampIterationSummary(
  observation: LegacyRampDecisionObservation | null,
  decision: CanonicalRampDecision,
  config: OppStressRampConfig,
  state: RampState
): OppStressRampEvidence {
  const fields = {
    iterationIndex: state.iterationIndex,
    accountCount: state.accountCount,
    startedAtMs: decision.controllerStartedAtMs,
    endedAtMs: decision.controllerEndedAtMs,
    status: summaryStatus(decision),
    preserveCluster: decision.preserveCluster,
    config,
    saturatedEndpoints: decision.saturatedEndpoints,
    missingEndpoints: decision.missingEndpoints,
    observedNonRequiredEndpoints:
      observation === null
        ? state.observedNonRequiredEndpoints
        : mergeRampDiagnostics(
            state.observedNonRequiredEndpoints,
            observation.value.observedNonRequiredEndpoints
          )
  }
  if (observation === null) {
    if (decision.kind !== "failed" || decision.schemaEvidence === null)
      throw new Error("Controller failure requires a failed evidence decision")
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
  const value = observation.value,
    observationFields = {
      phase: value.phase,
      observationStartedAtMs: value.observationStartedAtMs,
      observationEndedAtMs: value.observationEndedAtMs,
      txSuccesses: value.txSuccesses,
      txFailures: value.txFailures,
      envelopeCount: value.envelopeCount,
      envelopeByteSizes: value.envelopeByteSizes,
      endpoint: value.endpoint,
      epochStart: value.epochStart,
      epochEnd: value.epochEnd
    },
    observationSummary = {
      ...observationFields,
      saturatedEndpoints: value.saturatedEndpoints,
      observedNonRequiredEndpoints: value.observedNonRequiredEndpoints
    }
  if (value.kind === "breakage")
    if (decision.kind !== "failed")
      throw new Error("Breakage observation requires a failed decision")
    else
      return {
        ...fields,
        ...observationFields,
        kind: "breakage",
        observation: observationSummary,
        breakageCategory: decision.breakageCategory,
        breakageReason: decision.breakageReason
      }
  return {
    ...fields,
    ...observationFields,
    observation: observationSummary,
    kind: decision.outcome === "saturated" ? "saturated" : "not_saturated"
  }
}

/** Merge diagnostic endpoint labels in first-observation order. */
export function mergeRampDiagnostics(
  prior: readonly string[],
  current: readonly string[]
): readonly string[] {
  return [...new Set([...prior, ...current])]
}

function summaryStatus(
  decision: CanonicalRampDecision
): OppStressRampEvidence["status"] {
  return decision.status ?? "not_saturated"
}
