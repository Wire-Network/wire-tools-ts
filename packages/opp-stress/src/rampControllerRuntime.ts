import { match } from "ts-pattern"

import type {
  DeferredRampDecisionObservation,
  LegacyRampDecisionObservation,
  SchemaV1RampDecisionObservation
} from "./rampDecision.js"
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
export interface RampState {
  readonly accountCount: number
  readonly iterationIndex: number
  readonly priorIterations: readonly OppStressRampEvidence[]
  readonly priorSaturatedEndpoints: readonly RunEvidenceEndpoint[]
  readonly priorHealthyTelemetry: OppStressRampHealthyEndpointTelemetry
  readonly iterationRefs: readonly RunEvidenceIterationRecordRef[]
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Resolved mode-specific collaborators and allocation authority. */
export interface RampRuntime {
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
  return match(options)
    .with(
      { evidenceMode: OppStressRampEvidenceModeKind.SchemaV1 },
      schemaOptions => {
        const context = schemaOptions.persistence.assertActiveRampContext()
        assertRampConfig(context.rampConfig)
        return {
          mode: schemaOptions.evidenceMode,
          config: context.rampConfig,
          requiredEndpoints: parseOppStressRampRequiredEndpoints(
            context.requiredEndpoints
          ),
          allocationStartedAtMs: context.startedAtMs,
          persistence: schemaOptions.persistence,
          clock: schemaOptions.clock ?? Date.now,
          runIteration: schemaOptions.runIteration
        }
      }
    )
    .with(
      { evidenceMode: OppStressRampEvidenceModeKind.DeferredFlowMigration },
      deferredOptions => {
        const { config = defaultRampConfig() } = deferredOptions
        assertRampConfig(config)
        return {
          mode: deferredOptions.evidenceMode,
          config,
          requiredEndpoints: parseOppStressRampRequiredEndpoints(
            deferredOptions.requiredEndpoints
          ),
          allocationStartedAtMs: null,
          persistence: null,
          clock: deferredOptions.clock ?? Date.now,
          runIteration: deferredOptions.runIteration
        }
      }
    )
    .otherwise(assertNever)
}

/** Parse one callback with the exact boundary contract selected by runtime mode. */
export function parseRampObservation(
  runtime: RampRuntime,
  input: unknown
): LegacyRampDecisionObservation {
  return match(runtime.mode)
    .with(
      OppStressRampEvidenceModeKind.SchemaV1,
      (): SchemaV1RampDecisionObservation => ({
        mode: OppStressRampEvidenceModeKind.SchemaV1,
        value: parseOppStressRampSchemaObservation(
          input,
          runtime.requiredEndpoints
        )
      })
    )
    .with(
      OppStressRampEvidenceModeKind.DeferredFlowMigration,
      (): DeferredRampDecisionObservation => ({
        mode: OppStressRampEvidenceModeKind.DeferredFlowMigration,
        value: parseOppStressRampDeferredIterationObservation(
          input,
          runtime.requiredEndpoints
        )
      })
    )
    .otherwise(assertNever)
}

/** Closed controller-owned clock reads validated per iteration. */
export enum ControllerClockFieldKind {
  startedAtMs = "startedAtMs",
  endedAtMs = "endedAtMs"
}

/** Name of the controller-owned clock read being validated. */
export type ControllerClockField = `${ControllerClockFieldKind}`

/** Validate one controller-owned clock read as a safe non-negative integer. */
export function parseControllerClock(
  value: number,
  field: ControllerClockField
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
