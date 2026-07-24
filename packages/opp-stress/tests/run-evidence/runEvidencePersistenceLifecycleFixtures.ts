import { createEnvelopeBaseline } from "@wireio/debugging-shared"

import {
  OppEnvelopeTelemetryHealthKind,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePhaseStatus,
  RunEvidenceSaturationStrategy,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupStatus,
  RunEvidenceStage
} from "@wireio/test-opp-stress"

/** Required endpoint used by persistence lifecycle records. */
export const TestEndpoint = RunEvidenceEndpoint.DepotOutpostEthereum

/** Parser-valid successful setup record. */
export function successfulSetup() {
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Setup,
    status: RunEvidenceSetupStatus.Succeeded,
    startedAtMs: "101",
    endedAtMs: "102",
    clusterConfigCreated: true
  } as const
}

/** Parser-valid setup failure before or after config creation. */
export function failedSetup(clusterConfigCreated: boolean) {
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Setup,
    status: RunEvidenceSetupStatus.Failed,
    startedAtMs: "101",
    endedAtMs: "102",
    clusterConfigCreated,
    breakageCategory: RampBreakageCategory.Infrastructure,
    breakageReason: "setup failed"
  } as const
}

/** Healthy telemetry for one independently validated candidate. */
export function healthyTelemetry() {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Healthy,
    retryable: false,
    candidateCount: 1,
    validCount: 1,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  } as const
}

/** Empty retryable telemetry used before collection and on setup failure. */
export function emptyTelemetry() {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  } as const
}

/** Parser-valid iteration with configurable controller outcome. */
export function iterationRecord(
  iterationIndex: number,
  outcome:
    | RunEvidenceIterationOutcome.NotSaturated
    | RunEvidenceIterationOutcome.Saturated = RunEvidenceIterationOutcome.NotSaturated
) {
  const saturated = outcome === RunEvidenceIterationOutcome.Saturated,
    telemetry = healthyTelemetry()
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Iteration,
    iterationIndex,
    accountCount: 3 * 3 ** iterationIndex,
    startedAtMs: String(103 + iterationIndex * 2),
    endedAtMs: String(104 + iterationIndex * 2),
    outcome,
    requiredEndpoints: [TestEndpoint],
    saturatedEndpoints: saturated ? [TestEndpoint] : [],
    missingEndpoints: saturated ? [] : [TestEndpoint],
    endpointResults: [{ endpoint: TestEndpoint, telemetry, saturated }],
    telemetry,
    phases: [
      {
        status: RunEvidencePhaseStatus.Completed,
        label: `phase-${iterationIndex}`,
        endpoint: TestEndpoint,
        strategy: RunEvidenceSaturationStrategy.ByteThreshold,
        baseline: {
          ...createEnvelopeBaseline([]),
          observationOrdinal: String(iterationIndex),
          artifactRefs: []
        },
        window: {
          startedAtMs: String(103 + iterationIndex * 2),
          endedAtMs: String(104 + iterationIndex * 2),
          epochStart: "1",
          epochEnd: "1"
        },
        artifactRefs: [],
        telemetry,
        metrics: {
          txSuccesses: 1,
          txFailures: 0,
          envelopeCount: 1,
          envelopeByteSizes: [65_000],
          epochEnvelopeIndexes: [0],
          solanaOversized: false,
          saturated
        }
      }
    ]
  } as const
}

/** Parser-valid infrastructure-breakage iteration without saturation credit. */
export function breakageIteration(iterationIndex: number) {
  const telemetry = emptyTelemetry()
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Iteration,
    iterationIndex,
    accountCount: 3 * 3 ** iterationIndex,
    startedAtMs: String(103 + iterationIndex * 2),
    endedAtMs: String(104 + iterationIndex * 2),
    outcome: RunEvidenceIterationOutcome.Breakage,
    requiredEndpoints: [TestEndpoint],
    saturatedEndpoints: [],
    missingEndpoints: [TestEndpoint],
    endpointResults: [{ endpoint: TestEndpoint, telemetry, saturated: false }],
    telemetry,
    phases: [],
    breakageCategory: RampBreakageCategory.Infrastructure,
    breakageReason: "iteration infrastructure failure"
  } as const
}

/** Build a valid successful terminal from committed iteration refs. */
export function terminalRecord(
  lifecycle: RunEvidenceLifecycle.Saturated | RunEvidenceLifecycle.Incomplete,
  iterationRefs: readonly { readonly path: string; readonly sha256: string }[]
) {
  const saturated = lifecycle === RunEvidenceLifecycle.Saturated,
    telemetry = healthyTelemetry()
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Terminal,
    lifecycle,
    startedAtMs: "100",
    endedAtMs: "110",
    requiredEndpoints: [TestEndpoint],
    saturatedEndpoints: saturated ? [TestEndpoint] : [],
    missingEndpoints: saturated ? [] : [TestEndpoint],
    endpointResults: [{ endpoint: TestEndpoint, telemetry, saturated }],
    telemetry,
    iterationRefs,
    preserveCluster: !saturated
  } as const
}

/** Build a valid setup-failed terminal. */
export function setupFailedTerminal() {
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Terminal,
    lifecycle: RunEvidenceLifecycle.SetupFailed,
    startedAtMs: "100",
    endedAtMs: "103",
    requiredEndpoints: [TestEndpoint],
    saturatedEndpoints: [],
    missingEndpoints: [TestEndpoint],
    endpointResults: [
      { endpoint: TestEndpoint, telemetry: emptyTelemetry(), saturated: false }
    ],
    telemetry: emptyTelemetry(),
    iterationRefs: [],
    preserveCluster: true,
    breakageCategory: RampBreakageCategory.Infrastructure,
    breakageReason: "setup failed"
  } as const
}

/** Build a valid failed terminal from one or more committed iteration refs. */
export function failedTerminal(
  iterationRefs: readonly { readonly path: string; readonly sha256: string }[]
) {
  const telemetry = emptyTelemetry()
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Terminal,
    lifecycle: RunEvidenceLifecycle.Failed,
    startedAtMs: "100",
    endedAtMs: "110",
    requiredEndpoints: [TestEndpoint],
    saturatedEndpoints: [],
    missingEndpoints: [TestEndpoint],
    endpointResults: [{ endpoint: TestEndpoint, telemetry, saturated: false }],
    telemetry,
    iterationRefs,
    preserveCluster: true,
    breakageCategory: RampBreakageCategory.Infrastructure,
    breakageReason: "iteration infrastructure failure"
  } as const
}
