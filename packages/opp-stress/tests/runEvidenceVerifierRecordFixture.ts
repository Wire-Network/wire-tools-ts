import { createEnvelopeBaseline } from "@wireio/debugging-shared"

import {
  OppEnvelopeTelemetryHealthKind,
  RampBreakageCategory,
  RunEvidenceClusterConfigState,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePhaseStatus,
  RunEvidenceSaturationStrategy,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage,
  parseRunEvidenceIteration,
  type OppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"

import { writeVerifierArtifact } from "./runEvidenceVerifierArtifactFixture.js"
import type {
  BuiltVerifierRecords,
  VerifierPhaseSpec,
  VerifierRecordBuildInput
} from "./runEvidenceVerifierFixtureTypes.js"
import {
  emptyFixtureTelemetry,
  healthyFixtureTelemetry,
  initializingVerifierRecords,
  verifierSetupRecord,
  writeVerifierConfig
} from "./runEvidenceVerifierManifestFixture.js"
import {
  buildTerminalVerifierRecords,
  writeVerifierRecord
} from "./runEvidenceVerifierTerminalFixture.js"

/** Build and write every non-manifest record for one fixture. */
export function buildVerifierRecords(
  runDirectory: string,
  input: VerifierRecordBuildInput
): BuiltVerifierRecords {
  if (input.lifecycle === RunEvidenceLifecycle.Initializing)
    return initializingVerifierRecords()
  const setupFailed = input.lifecycle === RunEvidenceLifecycle.SetupFailed,
    configCreated = setupFailed ? input.configCreatedBeforeSetupFailure : true,
    setupRef = writeVerifierRecord(
      runDirectory,
      RunEvidencePath.Setup,
      verifierSetupRecord(setupFailed, configCreated)
    ),
    configSnapshot = configCreated
      ? writeVerifierConfig(runDirectory)
      : {
          kind: RunEvidenceClusterConfigState.Unavailable,
          reason: "cluster_config_not_created"
        }
  if (setupFailed)
    return buildTerminalVerifierRecords(
      runDirectory,
      input,
      setupRef,
      [],
      [],
      [],
      emptyFixtureTelemetry(),
      configSnapshot
    )
  if (input.lifecycle === RunEvidenceLifecycle.Running)
    return {
      setupRef,
      iterationRefs: [],
      terminalRef: null,
      artifacts: [],
      saturatedEndpoints: [],
      telemetry: emptyFixtureTelemetry(),
      configSnapshot
    }
  const built = buildIteration(runDirectory, input),
    parsed = parseRunEvidenceIteration(built.record)
  if ("error" in parsed)
    throw new Error(`generated iteration is invalid: ${parsed.error.code}`)
  const iterationRef = writeVerifierRecord(
    runDirectory,
    `${RunEvidencePath.Iterations}/000000.json`,
    built.record
  )
  return buildTerminalVerifierRecords(
    runDirectory,
    input,
    setupRef,
    [iterationRef],
    built.artifacts,
    built.saturatedEndpoints,
    built.telemetry,
    configSnapshot
  )
}

function buildIteration(runDirectory: string, input: VerifierRecordBuildInput) {
  const breakage = input.lifecycle === RunEvidenceLifecycle.Failed,
    phases =
      breakage && input.breakagePhaseTelemetry === undefined
        ? []
        : input.phases.map((phase, index) =>
            phaseRecord(
              runDirectory,
              breakage && input.breakagePhaseTelemetry !== undefined
                ? { ...phase, telemetry: input.breakagePhaseTelemetry }
                : phase,
              index,
              breakage
            )
          ),
    saturatedEndpoints = input.requiredEndpoints.filter(endpoint =>
      phases.some(
        phase =>
          phase.record.endpoint === endpoint && phase.record.metrics.saturated
      )
    ),
    missingEndpoints = input.requiredEndpoints.filter(
      endpoint => !saturatedEndpoints.includes(endpoint)
    ),
    telemetry = breakage
      ? (input.breakagePhaseTelemetry ?? emptyFixtureTelemetry())
      : (phases[0]?.record.telemetry ?? healthyFixtureTelemetry(phases.length)),
    outcome = breakage
      ? RunEvidenceIterationOutcome.Breakage
      : missingEndpoints.length === 0
        ? RunEvidenceIterationOutcome.Saturated
        : RunEvidenceIterationOutcome.NotSaturated,
    base = {
      schemaVersion: RunEvidenceSchemaVersion,
      stage: RunEvidenceStage.Iteration,
      iterationIndex: 0,
      accountCount: input.accountCount,
      startedAtMs: "103",
      endedAtMs: "104",
      outcome,
      requiredEndpoints: input.requiredEndpoints,
      saturatedEndpoints,
      missingEndpoints,
      endpointResults: input.requiredEndpoints.map(endpoint => ({
        endpoint,
        telemetry: endpointTelemetry(phases, endpoint),
        saturated: saturatedEndpoints.includes(endpoint)
      })),
      telemetry,
      phases: phases.map(phase => phase.record)
    }
  return {
    record: breakage
      ? {
          ...base,
          breakageCategory:
            telemetry.kind === OppEnvelopeTelemetryHealthKind.Degraded
              ? RampBreakageCategory.TelemetryIntegrity
              : RampBreakageCategory.Infrastructure,
          breakageReason: "iteration failed"
        }
      : base,
    artifacts: phases.map(phase => phase.artifact.artifact),
    saturatedEndpoints,
    telemetry
  }
}

function phaseRecord(
  runDirectory: string,
  spec: VerifierPhaseSpec,
  index: number,
  breakage: boolean
) {
  const artifact = writeVerifierArtifact(runDirectory, {
      ...spec,
      epoch: index + 1,
      observationOrdinal: String(index + 1)
    }),
    saturated =
      spec.strategy === RunEvidenceSaturationStrategy.Rollover
        ? spec.epochEnvelopeIndex > 0
        : spec.byteSize >= 62_259
  const base = {
    label: `phase-${index}`,
    endpoint: spec.endpoint,
    strategy: spec.strategy,
    baseline: {
      ...createEnvelopeBaseline([]),
      observationOrdinal: String(index),
      artifactRefs: []
    },
    window: {
      startedAtMs: "103",
      endedAtMs: "104",
      epochStart: String(index + 1),
      epochEnd: String(index + 1)
    },
    artifactRefs: artifact.refs,
    telemetry: spec.telemetry ?? healthyFixtureTelemetry(),
    metrics: {
      txSuccesses: 1,
      txFailures: 0,
      envelopeCount: 1,
      envelopeByteSizes: [artifact.byteSize],
      epochEnvelopeIndexes: [artifact.epochEnvelopeIndex],
      solanaOversized:
        spec.endpoint === RunEvidenceEndpoint.DepotOutpostSolana &&
        artifact.byteSize > 1_232,
      saturated: breakage ? false : saturated
    }
  } as const
  return {
    artifact,
    record: breakage
      ? {
          ...base,
          status: RunEvidencePhaseStatus.Breakage,
          breakageCategory:
            base.telemetry.kind === OppEnvelopeTelemetryHealthKind.Degraded
              ? RampBreakageCategory.TelemetryIntegrity
              : RampBreakageCategory.Infrastructure,
          breakageReason: "phase failed"
        }
      : { ...base, status: RunEvidencePhaseStatus.Completed }
  } as const
}

function endpointTelemetry(
  phases: readonly ReturnType<typeof phaseRecord>[],
  endpoint: RunEvidenceEndpoint
): OppEnvelopeTelemetryHealth {
  const matching = phases.filter(phase => phase.record.endpoint === endpoint)
  const first = matching[0]
  if (first === undefined) return emptyFixtureTelemetry()
  return matching.length === 1
    ? first.record.telemetry
    : healthyFixtureTelemetry(matching.length)
}
