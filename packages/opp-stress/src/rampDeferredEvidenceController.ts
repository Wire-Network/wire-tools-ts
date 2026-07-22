import { assertRampConfig, defaultRampConfig } from "./rampControllerConfig.js"
import { decideRampControllerFailure } from "./rampControllerFailureDecision.js"
import { renderRampFailureReason } from "./rampControllerFailureReason.js"
import { parseControllerClock } from "./rampControllerRuntime.js"
import { decideRampIteration } from "./rampDecision.js"
import { parseOppStressRampDeferredEvidenceObservation } from "./rampDeferredEvidenceObservation.js"
import {
  deferredEvidenceIterationSummary,
  type DeferredEvidenceSummaryState
} from "./rampDeferredEvidenceSummary.js"
import type {
  OppStressRampDeferredEvidenceIterationObservation,
  OppStressRampDeferredEvidenceOptions,
  OppStressRampDeferredEvidenceResult,
  OppStressRampDeferredEvidenceSummary
} from "./rampDeferredEvidenceTypes.js"
import { OppStressRampEvidenceModeKind } from "./rampControllerTypes.js"
import { isOppStressRampTelemetryIntegrityError } from "./OppStressRampTelemetryIntegrityError.js"
import type {
  OppStressRampConfig,
  OppStressRampHealthyEndpointTelemetry,
  OppStressRampIterationInput
} from "./rampControllerTypes.js"
import {
  OppStressRampInvalidObservationError,
  parseOppStressRampRequiredEndpoints
} from "./rampObservation.js"
import { settleRampIteration } from "./rampSettledIteration.js"
import { RampBreakageCategory } from "./runEvidenceTypes.js"
import type { RunEvidenceEndpoint } from "./runEvidenceTypes.js"

type DeferredEvidenceRuntime<TEvidence extends object> = {
  readonly config: OppStressRampConfig
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly clock: () => number
  readonly parseEvidence: OppStressRampDeferredEvidenceOptions<TEvidence>["parseEvidence"]
  readonly runIteration: OppStressRampDeferredEvidenceOptions<TEvidence>["runIteration"]
}

type DeferredEvidenceState<TEvidence extends object> =
  DeferredEvidenceSummaryState & {
    readonly priorIterations: readonly OppStressRampDeferredEvidenceSummary<TEvidence>[]
    readonly priorSaturatedEndpoints: readonly RunEvidenceEndpoint[]
    readonly priorHealthyTelemetry: OppStressRampHealthyEndpointTelemetry
  }

/**
 * Run the explicit no-write generic deferred controller path.
 * @param options Typed callback, evidence parser, endpoints, clock, and config.
 * @returns Final controller result retaining typed callback observations.
 */
export function runOppStressRampDeferredEvidence<TEvidence extends object>(
  options: OppStressRampDeferredEvidenceOptions<TEvidence>
): Promise<OppStressRampDeferredEvidenceResult<TEvidence>> {
  const runtime = resolveRuntime(options)
  return runRampAtCount(runtime, {
    accountCount: runtime.config.initialCount,
    iterationIndex: 0,
    priorIterations: [],
    priorSaturatedEndpoints: [],
    priorHealthyTelemetry: new Map(),
    observedNonRequiredEndpoints: []
  })
}

function resolveRuntime<TEvidence extends object>(
  options: OppStressRampDeferredEvidenceOptions<TEvidence>
): DeferredEvidenceRuntime<TEvidence> {
  const config = options.config ?? defaultRampConfig()
  assertRampConfig(config)
  return {
    config,
    requiredEndpoints: parseOppStressRampRequiredEndpoints(
      options.requiredEndpoints
    ),
    clock: options.clock ?? Date.now,
    parseEvidence: options.parseEvidence,
    runIteration: options.runIteration
  }
}

async function runRampAtCount<TEvidence extends object>(
  runtime: DeferredEvidenceRuntime<TEvidence>,
  state: DeferredEvidenceState<TEvidence>
): Promise<OppStressRampDeferredEvidenceResult<TEvidence>> {
  const iterationInput: OppStressRampIterationInput = {
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
    return completeIteration(
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
  let observation: OppStressRampDeferredEvidenceIterationObservation<TEvidence>,
    decision: ReturnType<typeof decideRampIteration<TEvidence>>
  try {
    observation = parseOppStressRampDeferredEvidenceObservation(
      callback.value,
      runtime.requiredEndpoints,
      runtime.parseEvidence
    )
    decision = decideRampIteration({
      observation: {
        mode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        value: observation
      },
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
    return completeIteration(
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
  return completeIteration(runtime, state, observation, decision)
}

function completeIteration<TEvidence extends object>(
  runtime: DeferredEvidenceRuntime<TEvidence>,
  state: DeferredEvidenceState<TEvidence>,
  observation: OppStressRampDeferredEvidenceIterationObservation<TEvidence> | null,
  decision: ReturnType<typeof decideRampIteration<TEvidence>>
): Promise<OppStressRampDeferredEvidenceResult<TEvidence>> {
  const summary = deferredEvidenceIterationSummary(
      observation,
      decision,
      runtime.config,
      state
    ),
    iterations = [...state.priorIterations, summary]
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
      observedNonRequiredEndpoints: summary.observedNonRequiredEndpoints
    })
  return Promise.resolve({
    status: decision.status,
    preserveCluster: decision.preserveCluster,
    iterations,
    saturatedEndpoints: decision.saturatedEndpoints,
    missingEndpoints: decision.missingEndpoints,
    observedNonRequiredEndpoints: summary.observedNonRequiredEndpoints
  })
}
