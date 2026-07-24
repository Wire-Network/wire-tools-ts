import type { CanonicalRampDecision } from "./rampDecision.js"
import type { RampRuntime, RampState } from "./rampControllerRuntime.js"
import { OppStressRampInvalidObservationError } from "./rampObservation.js"
import { OppStressRampEvidenceModeKind } from "./rampControllerTypes.js"
import {
  RunEvidenceSchemaVersion,
  RunEvidenceStage,
  parseRunEvidenceIteration,
  parseRunEvidenceTerminal,
  type RunEvidenceDecimal,
  type RunEvidenceIteration,
  type RunEvidenceIterationRecordRef,
  type RunEvidenceTerminal
} from "./runEvidenceTypes.js"

/** Build, parse, and atomically publish one schema-v1 iteration when active. */
export async function publishRampIteration(
  runtime: RampRuntime,
  state: RampState,
  decision: CanonicalRampDecision
): Promise<RunEvidenceIterationRecordRef | null> {
  if (
    runtime.mode === OppStressRampEvidenceModeKind.DeferredFlowMigration ||
    runtime.persistence === null
  )
    return null
  return runtime.persistence.publishIteration(iterationRecord(state, decision))
}

/** Build, parse, and atomically publish the terminal from the same decision. */
export async function publishRampTerminal(
  runtime: RampRuntime,
  decision: Exclude<CanonicalRampDecision, { readonly kind: "continue" }>,
  iterationRefs: readonly RunEvidenceIterationRecordRef[]
): Promise<void> {
  if (
    runtime.mode === OppStressRampEvidenceModeKind.DeferredFlowMigration ||
    runtime.persistence === null
  )
    return
  if (runtime.allocationStartedAtMs === null)
    throw new OppStressRampInvalidObservationError(
      "schema-v1 allocation start is unavailable"
    )
  await runtime.persistence.publishTerminal(
    terminalRecord(runtime.allocationStartedAtMs, decision, iterationRefs)
  )
}

function iterationRecord(
  state: RampState,
  decision: CanonicalRampDecision
): RunEvidenceIteration {
  const schema = requireSchemaEvidence(decision),
    base = {
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Iteration,
      iterationIndex: state.iterationIndex,
      accountCount: state.accountCount,
      startedAtMs: decision.startedAtMs,
      endedAtMs: decision.endedAtMs,
      outcome: decision.outcome,
      requiredEndpoints: decision.requiredEndpoints,
      saturatedEndpoints: decision.saturatedEndpoints,
      missingEndpoints: decision.missingEndpoints,
      endpointResults: schema.endpointResults,
      telemetry: schema.telemetry,
      phases: schema.phases
    },
    value =
      decision.kind === "failed"
        ? {
            ...base,
            breakageCategory: decision.breakageCategory,
            breakageReason: decision.breakageReason
          }
        : base,
    parsed = parseRunEvidenceIteration(value)
  if ("error" in parsed)
    throw new OppStressRampInvalidObservationError(
      `controller iteration is not schema-v1 valid: ${parsed.error.code}`
    )
  return parsed.value
}

function terminalRecord(
  allocationStartedAtMs: RunEvidenceDecimal,
  decision: Exclude<CanonicalRampDecision, { readonly kind: "continue" }>,
  iterationRefs: readonly RunEvidenceIterationRecordRef[]
): RunEvidenceTerminal {
  const schema = requireSchemaEvidence(decision),
    base = {
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Terminal,
      lifecycle: decision.lifecycle,
      startedAtMs: allocationStartedAtMs,
      endedAtMs: decision.endedAtMs,
      requiredEndpoints: decision.requiredEndpoints,
      saturatedEndpoints: decision.saturatedEndpoints,
      missingEndpoints: decision.missingEndpoints,
      endpointResults: schema.endpointResults,
      telemetry: schema.telemetry,
      iterationRefs,
      preserveCluster: decision.preserveCluster
    },
    value =
      decision.kind === "failed"
        ? {
            ...base,
            breakageCategory: decision.breakageCategory,
            breakageReason: decision.breakageReason
          }
        : base,
    parsed = parseRunEvidenceTerminal(value)
  if ("error" in parsed)
    throw new OppStressRampInvalidObservationError(
      `controller terminal is not schema-v1 valid: ${parsed.error.code}`
    )
  return parsed.value
}

function requireSchemaEvidence(
  decision: CanonicalRampDecision
): NonNullable<CanonicalRampDecision["schemaEvidence"]> {
  if (decision.schemaEvidence === null)
    throw new OppStressRampInvalidObservationError(
      "schema-v1 decision evidence is unavailable"
    )
  return decision.schemaEvidence
}
