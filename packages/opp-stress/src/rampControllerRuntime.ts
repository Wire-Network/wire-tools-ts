import type { LegacyRampDecisionObservation } from "./rampDecision.js"
import {
  OppStressRampInvalidObservationError,
  parseOppStressRampDeferredIterationObservation,
  parseOppStressRampRequiredEndpoints
} from "./rampObservation.js"
import { parseOppStressRampSchemaObservation } from "./rampSchemaObservation.js"
import { assertRampConfig, defaultRampConfig } from "./rampControllerConfig.js"
import {
  OppStressRampEvidenceModeKind,
  type OppStressRampConfig,
  type OppStressRampEvidence,
  type OppStressRampHealthyEndpointTelemetry,
  type OppStressRampIterationInput,
  type OppStressRampOptions
} from "./rampControllerTypes.js"
import type { RunEvidencePersistence } from "./runEvidencePersistence.js"
import type {
  RunEvidenceDecimal,
  RunEvidenceEndpoint,
  RunEvidenceIterationRecordRef
} from "./runEvidenceTypes.js"

/** Immutable recursive controller state between ramp iterations. */
export type RampState = {
  readonly accountCount: number
  readonly iterationIndex: number
  readonly priorIterations: readonly OppStressRampEvidence[]
  readonly priorSaturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly priorHealthyTelemetry: OppStressRampHealthyEndpointTelemetry
  readonly iterationRefs: readonly RunEvidenceIterationRecordRef[]
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Resolved mode-specific collaborators and allocation authority. */
export type RampRuntime = {
  readonly mode: OppStressRampEvidenceModeKind
  readonly config: OppStressRampConfig
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly allocationStartedAtMs: RunEvidenceDecimal | null
  readonly persistence: RunEvidencePersistence | null
  readonly clock: () => number
  readonly runIteration: (
    input: OppStressRampIterationInput
  ) => Promise<unknown>
}

/** Resolve schema allocation authority or explicit deferred flow inputs. */
export function resolveRampRuntime(options: OppStressRampOptions): RampRuntime {
  switch (options.evidenceMode) {
    case OppStressRampEvidenceModeKind.SchemaV1: {
      const context = options.persistence.requireActiveRampContext()
      assertRampConfig(context.rampConfig)
      return {
        mode: options.evidenceMode,
        config: context.rampConfig,
        requiredEndpoints: parseOppStressRampRequiredEndpoints(
          context.requiredEndpoints
        ),
        allocationStartedAtMs: context.startedAtMs,
        persistence: options.persistence,
        clock: options.clock ?? Date.now,
        runIteration: options.runIteration
      }
    }
    case OppStressRampEvidenceModeKind.DeferredFlowMigration: {
      const config = options.config ?? defaultRampConfig()
      assertRampConfig(config)
      return {
        mode: options.evidenceMode,
        config,
        requiredEndpoints: parseOppStressRampRequiredEndpoints(
          options.requiredEndpoints
        ),
        allocationStartedAtMs: null,
        persistence: null,
        clock: options.clock ?? Date.now,
        runIteration: options.runIteration
      }
    }
    default:
      return assertNever(options)
  }
}

/** Parse one callback with the exact boundary contract selected by runtime mode. */
export function parseRampObservation(
  runtime: RampRuntime,
  input: unknown
): LegacyRampDecisionObservation {
  switch (runtime.mode) {
    case OppStressRampEvidenceModeKind.SchemaV1:
      return {
        mode: OppStressRampEvidenceModeKind.SchemaV1,
        value: parseOppStressRampSchemaObservation(
          input,
          runtime.requiredEndpoints
        )
      }
    case OppStressRampEvidenceModeKind.DeferredFlowMigration:
      return {
        mode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        value: parseOppStressRampDeferredIterationObservation(
          input,
          runtime.requiredEndpoints
        )
      }
    default:
      return assertNever(runtime.mode)
  }
}

/** Validate one controller-owned clock read as a safe non-negative integer. */
export function parseControllerClock(
  value: number,
  field: "startedAtMs" | "endedAtMs"
): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new OppStressRampInvalidObservationError(
      `clock ${field} must be a non-negative safe integer`
    )
  return value
}

function assertNever(value: never): never {
  throw new Error(`Unexpected OPP stress ramp runtime: ${String(value)}`)
}
