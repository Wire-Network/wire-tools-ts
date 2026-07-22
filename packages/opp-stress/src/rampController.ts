import { decideRampIteration } from "./rampDecision.js"
import { decideRampControllerFailure } from "./rampControllerFailureDecision.js"
import { renderRampFailureReason } from "./rampControllerFailureReason.js"
import {
  parseControllerClock,
  parseRampObservation,
  resolveRampRuntime,
  type RampRuntime,
  type RampState
} from "./rampControllerRuntime.js"
import {
  publishRampIteration,
  publishRampTerminal
} from "./rampEvidencePublication.js"
import {
  mergeRampDiagnostics,
  rampIterationSummary
} from "./rampIterationSummary.js"
import { OppStressRampInvalidObservationError } from "./rampObservation.js"
import { isOppStressRampTelemetryIntegrityError } from "./OppStressRampTelemetryIntegrityError.js"
import { RampBreakageCategory } from "./runEvidenceTypes.js"
import {
  OppStressRampEvidenceModeKind,
  type OppStressRampDeferredOptions,
  type OppStressRampOptions,
  type OppStressRampResult,
  type OppStressRampSchemaV1Options
} from "./rampControllerTypes.js"
import { runOppStressRampDeferredEvidence } from "./rampDeferredEvidenceController.js"
import type {
  OppStressRampDeferredEvidenceOptions,
  OppStressRampDeferredEvidenceResult
} from "./rampDeferredEvidenceTypes.js"
import { settleRampIteration } from "./rampSettledIteration.js"

export { OppStressRampInvalidObservationError } from "./rampObservation.js"
export { OppStressRampTelemetryIntegrityError } from "./OppStressRampTelemetryIntegrityError.js"
export {
  OppStressRampDefaults,
  OppStressRampEvidenceModeKind,
  type OppStressRampBreakageObservation,
  type OppStressRampBoundaryFailureEvidence,
  type OppStressRampCompletedObservation,
  type OppStressRampConfig,
  type OppStressRampDeferredBreakageObservation,
  type OppStressRampDeferredCompletedObservation,
  type OppStressRampDeferredIterationObservation,
  type OppStressRampEndpointTelemetry,
  type OppStressRampEvidence,
  type OppStressRampIterationInput,
  type OppStressRampIterationObservation,
  type OppStressRampObservationEvidence,
  type OppStressRampObservationBackedEvidence,
  type OppStressRampOptions,
  type OppStressRampResult,
  type OppStressRampResultStatus
} from "./rampControllerTypes.js"

/**
 * Run OPP stress iterations until saturation, explicit breakage, or exact max.
 * @param options Durable schema-v1 or explicit temporary no-write flow mode.
 * @returns Final status and canonical in-memory iteration summaries.
 */
export function runOppStressRamp(
  options: OppStressRampSchemaV1Options
): Promise<OppStressRampResult>
export function runOppStressRamp(
  options: OppStressRampDeferredOptions
): Promise<OppStressRampResult>
export function runOppStressRamp<TEvidence extends object>(
  options: OppStressRampDeferredEvidenceOptions<TEvidence>
): Promise<OppStressRampDeferredEvidenceResult<TEvidence>>
export function runOppStressRamp<TEvidence extends object>(
  options:
    OppStressRampOptions | OppStressRampDeferredEvidenceOptions<TEvidence>
):
  | Promise<OppStressRampResult>
  | Promise<OppStressRampDeferredEvidenceResult<TEvidence>> {
  return isDeferredEvidenceOptions(options)
    ? runOppStressRampDeferredEvidence(options)
    : runCanonicalOppStressRamp(options)
}

async function runCanonicalOppStressRamp(
  options: OppStressRampOptions
): Promise<OppStressRampResult> {
  const runtime = resolveRampRuntime(options)
  return runRampAtCount(runtime, {
    accountCount: runtime.config.initialCount,
    iterationIndex: 0,
    priorIterations: [],
    priorSaturatedEndpoints: [],
    priorHealthyTelemetry: new Map(),
    iterationRefs: [],
    observedNonRequiredEndpoints: []
  })
}

async function runRampAtCount(
  runtime: RampRuntime,
  state: RampState
): Promise<OppStressRampResult> {
  const iterationInput = {
      iterationIndex: state.iterationIndex,
      accountCount: state.accountCount,
      phaseTimeoutMs: runtime.config.phaseTimeoutMs
    },
    controllerStartedAtMs = parseControllerClock(
      runtime.clock(),
      "startedAtMs"
    ),
    callback = await settleRampIteration(runtime.runIteration, iterationInput),
    controllerEndedAtMs = parseControllerClock(runtime.clock(), "endedAtMs")
  if (controllerEndedAtMs < controllerStartedAtMs)
    throw new OppStressRampInvalidObservationError(
      "controller clock window must be ordered"
    )
  if (callback.kind === "rejected")
    return completeRampIteration(
      runtime,
      state,
      null,
      decideRampControllerFailure({
        requiredEndpoints: runtime.requiredEndpoints,
        priorSaturatedEndpoints: state.priorSaturatedEndpoints,
        priorHealthyTelemetry: state.priorHealthyTelemetry,
        controllerStartedAtMs,
        controllerEndedAtMs,
        reason: renderRampFailureReason(callback.cause),
        cause: callback.cause,
        ...(isOppStressRampTelemetryIntegrityError(callback.cause)
          ? {
              category: RampBreakageCategory.TelemetryIntegrity,
              telemetry: callback.cause.telemetry
            }
          : {
              category: RampBreakageCategory.Infrastructure,
              telemetry: null
            })
      })
    )
  let observation: ReturnType<typeof parseRampObservation>,
    decision: ReturnType<typeof decideRampIteration>
  try {
    observation = parseRampObservation(runtime, callback.value)
    decision = decideRampIteration({
      observation,
      requiredEndpoints: runtime.requiredEndpoints,
      priorSaturatedEndpoints: state.priorSaturatedEndpoints,
      priorHealthyTelemetry: state.priorHealthyTelemetry,
      accountCount: state.accountCount,
      maxCount: runtime.config.maxCount,
      controllerStartedAtMs,
      controllerEndedAtMs
    })
  } catch (error) {
    if (!(error instanceof OppStressRampInvalidObservationError)) throw error
    return completeRampIteration(
      runtime,
      state,
      null,
      decideRampControllerFailure({
        requiredEndpoints: runtime.requiredEndpoints,
        priorSaturatedEndpoints: state.priorSaturatedEndpoints,
        priorHealthyTelemetry: state.priorHealthyTelemetry,
        controllerStartedAtMs,
        controllerEndedAtMs,
        category: RampBreakageCategory.InvalidObservation,
        telemetry: null,
        reason: renderRampFailureReason(error),
        cause: error
      })
    )
  }
  return completeRampIteration(runtime, state, observation, decision)
}

async function completeRampIteration(
  runtime: RampRuntime,
  state: RampState,
  observation: ReturnType<typeof parseRampObservation> | null,
  decision: ReturnType<typeof decideRampIteration>
): Promise<OppStressRampResult> {
  const summary = rampIterationSummary(
      observation,
      decision,
      runtime.config,
      state
    ),
    iterationRef = await publishRampIteration(runtime, state, decision),
    iterationRefs =
      iterationRef === null
        ? state.iterationRefs
        : [...state.iterationRefs, iterationRef],
    iterations = [...state.priorIterations, summary],
    observedNonRequiredEndpoints =
      observation === null
        ? state.observedNonRequiredEndpoints
        : mergeRampDiagnostics(
            state.observedNonRequiredEndpoints,
            observation.value.observedNonRequiredEndpoints
          )
  if (decision.kind === "continue")
    return runRampAtCount(runtime, {
      accountCount: Math.min(
        state.accountCount * runtime.config.multiplier,
        runtime.config.maxCount
      ),
      iterationIndex: state.iterationIndex + 1,
      priorIterations: iterations,
      priorSaturatedEndpoints: decision.saturatedEndpoints,
      priorHealthyTelemetry: decision.nextHealthyTelemetry,
      iterationRefs,
      observedNonRequiredEndpoints
    })
  await publishRampTerminal(runtime, decision, iterationRefs)
  return {
    status: decision.status,
    preserveCluster: decision.preserveCluster,
    iterations,
    saturatedEndpoints: decision.saturatedEndpoints,
    missingEndpoints: decision.missingEndpoints,
    observedNonRequiredEndpoints
  }
}

function isDeferredEvidenceOptions<TEvidence extends object>(
  options:
    OppStressRampOptions | OppStressRampDeferredEvidenceOptions<TEvidence>
): options is OppStressRampDeferredEvidenceOptions<TEvidence> {
  return (
    options.evidenceMode ===
      OppStressRampEvidenceModeKind.DeferredFlowMigration &&
    Object.hasOwn(options, "parseEvidence")
  )
}
