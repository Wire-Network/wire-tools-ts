import type {
  OppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth
} from "../envelopeMetricTypes.js"
import {
  RunEvidenceClusterConfigState,
  RunEvidenceConfigUnavailableReason,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupRefState,
  RunEvidenceSetupStatus
} from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceClusterConfigSnapshot,
  RunEvidenceDecimal,
  RunEvidenceIterationRecordRef,
  RunEvidenceProvenance,
  RunEvidenceRampConfig,
  RunEvidenceRuntime,
  RunEvidenceSetupRecordRef,
  RunEvidenceTerminalRecordRef
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type {
  RunEvidenceIteration,
  RunEvidenceSetup,
  RunEvidenceTerminal
} from "./RunEvidenceRecordTypes.js"
import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./RunEvidencePersistenceError.js"
import { parseRunEvidenceManifest } from "./runEvidenceManifestParser.js"

/** Inputs that become the immutable identity fields of an initial manifest. */
export type InitialManifestInput = {
  readonly runId: string
  readonly startedAtMs: RunEvidenceDecimal
  readonly clusterPath: string
  readonly rampConfig: RunEvidenceRampConfig
  readonly requiredEndpoints: RunEvidenceManifest["requiredEndpoints"]
  readonly runtime: RunEvidenceRuntime
  readonly provenance: RunEvidenceProvenance
  readonly telemetry: OppEnvelopeTelemetryHealth
}

/** Successful setup inputs required to enter the running lifecycle. */
export type RunningSetupInput = {
  readonly manifest: RunEvidenceManifest
  readonly setup: RunEvidenceSetup
  readonly setupRef: RunEvidenceSetupRecordRef
  readonly config: RunEvidenceClusterConfigSnapshot
}

/** Terminal decision and immutable refs required for a terminal checkpoint. */
export type TerminalManifestInput = {
  readonly manifest: RunEvidenceManifest
  readonly setup: RunEvidenceSetup
  readonly setupRef: RunEvidenceSetupRecordRef
  readonly iterationRefs: readonly RunEvidenceIterationRecordRef[]
  readonly terminal: RunEvidenceTerminal
  readonly terminalRef: RunEvidenceTerminalRecordRef
  readonly config: RunEvidenceClusterConfigSnapshot
  readonly artifacts: readonly RunEvidenceArtifact[]
}

/** Build and parse the initial pending schema-v1 manifest. */
export function initialManifest(
  input: InitialManifestInput
): RunEvidenceManifest {
  return requireManifest({
    schemaVersion: RunEvidenceSchemaVersion,
    runId: input.runId,
    lifecycle: RunEvidenceLifecycle.Initializing,
    startedAtMs: input.startedAtMs,
    updatedAtMs: input.startedAtMs,
    clusterPath: input.clusterPath,
    rampConfig: input.rampConfig,
    requiredEndpoints: input.requiredEndpoints,
    saturatedEndpoints: [],
    missingEndpoints: input.requiredEndpoints,
    preserveCluster: true,
    telemetry: input.telemetry,
    runtime: input.runtime,
    provenance: input.provenance,
    clusterConfigSnapshot: { kind: RunEvidenceClusterConfigState.Pending },
    records: {
      setup: { kind: RunEvidenceSetupRefState.Pending },
      iterations: [],
      terminal: null
    },
    artifacts: []
  })
}

/** Advance an initializing manifest to running after successful setup. */
export function runningManifestAfterSetup(
  input: RunningSetupInput
): RunEvidenceManifest {
  return requireManifest({
    ...input.manifest,
    lifecycle: RunEvidenceLifecycle.Running,
    updatedAtMs: maxDecimal(input.manifest.updatedAtMs, input.setup.endedAtMs),
    clusterConfigSnapshot: input.config,
    records: { setup: input.setupRef, iterations: [], terminal: null }
  })
}

export function runningManifestAfterIteration(
  manifest: RunEvidenceManifest,
  iteration: RunEvidenceIteration,
  iterationRef: RunEvidenceIterationRecordRef
): RunEvidenceManifest {
  const decision =
    iteration.outcome === RunEvidenceIterationOutcome.NotSaturated
      ? {
          saturatedEndpoints: iteration.saturatedEndpoints,
          missingEndpoints: iteration.missingEndpoints,
          telemetry: iteration.telemetry
        }
      : {
          saturatedEndpoints: manifest.saturatedEndpoints,
          missingEndpoints: manifest.missingEndpoints,
          telemetry: manifest.telemetry
        }
  return requireManifest({
    ...manifest,
    ...decision,
    updatedAtMs: maxDecimal(manifest.updatedAtMs, iteration.endedAtMs),
    records: {
      setup: manifest.records.setup,
      iterations: [...manifest.records.iterations, iterationRef],
      terminal: null
    }
  })
}

export function runningManifestWithArtifacts(
  manifest: RunEvidenceManifest,
  artifacts: readonly RunEvidenceArtifact[],
  updatedAtMs: RunEvidenceDecimal
): RunEvidenceManifest {
  return requireManifest({
    ...manifest,
    updatedAtMs: maxDecimal(manifest.updatedAtMs, updatedAtMs),
    artifacts
  })
}

/** Build a terminal manifest from the committed terminal decision and refs. */
export function terminalManifest(
  input: TerminalManifestInput
): RunEvidenceManifest {
  const terminalTelemetry:
    OppEnvelopeTelemetryHealth | HealthyOppEnvelopeTelemetryHealth =
    input.terminal.telemetry
  return requireManifest({
    ...input.manifest,
    lifecycle: input.terminal.lifecycle,
    updatedAtMs: maxDecimal(
      input.manifest.updatedAtMs,
      input.terminal.endedAtMs
    ),
    saturatedEndpoints: input.terminal.saturatedEndpoints,
    missingEndpoints: input.terminal.missingEndpoints,
    preserveCluster: input.terminal.preserveCluster,
    telemetry: terminalTelemetry,
    clusterConfigSnapshot:
      input.setup.status === RunEvidenceSetupStatus.Failed &&
      !input.setup.clusterConfigCreated
        ? {
            kind: RunEvidenceClusterConfigState.Unavailable,
            reason: RunEvidenceConfigUnavailableReason.ClusterConfigNotCreated
          }
        : input.config,
    records: {
      setup: input.setupRef,
      iterations: input.iterationRefs,
      terminal: input.terminalRef
    },
    artifacts:
      input.terminal.lifecycle === RunEvidenceLifecycle.SetupFailed
        ? []
        : input.artifacts
  })
}

function requireManifest(value: unknown): RunEvidenceManifest {
  const parsed = parseRunEvidenceManifest(value)
  if ("error" in parsed)
    throw new RunEvidencePersistenceError(
      RunEvidencePersistenceErrorCode.InvalidState,
      `manifest transition is not schema-v1 valid: ${parsed.error.code}`
    )
  return parsed.value
}

function maxDecimal(
  first: RunEvidenceDecimal,
  second: RunEvidenceDecimal
): RunEvidenceDecimal {
  return BigInt(first) >= BigInt(second) ? first : second
}
