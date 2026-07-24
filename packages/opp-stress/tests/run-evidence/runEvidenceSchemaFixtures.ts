import { createEnvelopeBaseline } from "@wireio/debugging-shared"

import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  RampBreakageCategory,
  RunEvidenceClusterConfigState,
  RunEvidenceEndpoint,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePhaseStatus,
  RunEvidenceSaturationStrategy,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupRefState,
  RunEvidenceStage
} from "@wireio/test-opp-stress"

/** Primary required endpoint used by schema fixtures. */
export const EvidenceEndpoint = RunEvidenceEndpoint.DepotOutpostSolana

/** Alternate canonical endpoint used by coverage mutations. */
export const AlternateEndpoint = RunEvidenceEndpoint.OutpostEthereumDepot

/** Canonical artifact base key used by schema fixtures. */
export const EvidenceBaseKey = "87654321-DEPOT_OUTPOST_SOLANA-fedcba9876543210"

/** Canonical relative data artifact reference. */
export const EvidenceDataRef = `${RunEvidencePath.Artifacts}/${EvidenceBaseKey}.data`

/** Canonical relative metadata artifact reference. */
export const EvidenceMetadataRef = `${RunEvidencePath.Artifacts}/${EvidenceBaseKey}.metadata`

/** Full lowercase lifecycle-record digest used by fixtures. */
export const EvidenceRecordSha256 = "c".repeat(64)

/** Immutable setup record ref used after setup commit. */
export const setupRecordRef = {
  path: RunEvidencePath.Setup,
  sha256: EvidenceRecordSha256
}

/** First immutable iteration record ref. */
export const iterationRecordRef = {
  path: `${RunEvidencePath.Iterations}/000000.json`,
  sha256: EvidenceRecordSha256
}

/** Immutable terminal record ref used after terminal commit. */
export const terminalRecordRef = {
  path: RunEvidencePath.Terminal,
  sha256: EvidenceRecordSha256
}

/** Committed setup, first iteration, and terminal refs. */
export const committedRecordRefs = {
  setup: setupRecordRef,
  iterations: [iterationRecordRef],
  terminal: terminalRecordRef
}

/** Captured cluster-config snapshot fixture. */
export const capturedSnapshot = {
  kind: RunEvidenceClusterConfigState.Captured,
  path: RunEvidencePath.ClusterConfigSnapshot,
  sha256: EvidenceRecordSha256
}

/** Empty telemetry before any candidate is observed. */
export const emptyTelemetry = {
  kind: OppEnvelopeTelemetryHealthKind.Empty,
  retryable: true,
  candidateCount: 0,
  validCount: 0,
  filteredCount: 0,
  issueCount: 0,
  issues: []
}

/** Healthy telemetry for one validated artifact pair. */
export const healthyTelemetry = {
  kind: OppEnvelopeTelemetryHealthKind.Healthy,
  retryable: false,
  candidateCount: 1,
  validCount: 1,
  filteredCount: 0,
  issueCount: 0,
  issues: []
}

/** Terminal integrity telemetry used by typed breakage fixtures. */
export const degradedTelemetry = {
  kind: OppEnvelopeTelemetryHealthKind.Degraded,
  retryable: false,
  candidateCount: 1,
  validCount: 0,
  filteredCount: 0,
  issueCount: 1,
  issues: [
    {
      code: OppEnvelopeTelemetryIssueCode.DataHashMismatch,
      baseKey: EvidenceBaseKey,
      context: {
        expectedHashPrefix: "expected",
        actualHashPrefix: "actual",
        actualSha256: "f".repeat(64)
      }
    }
  ]
}

/** Complete immutable artifact entry. */
export const artifactEntry = {
  baseKey: EvidenceBaseKey,
  firstImmutableRefs: {
    data: { path: EvidenceDataRef, sha256: "a".repeat(64) },
    metadata: { path: EvidenceMetadataRef, sha256: "b".repeat(64) }
  },
  firstAcceptedObservationOrdinal: "41",
  lastAcceptedObservationOrdinal: "43",
  lastAcceptedBatchOpNames: ["operator.alpha", "operator.zeta"]
}

/** Absolute normalized run provenance. */
export const provenance = {
  wireBuildPath: "/srv/wire/build/debug",
  ethereumPath: "/srv/wire/ethereum",
  solanaPath: "/srv/wire/solana"
}

/** Complete phase metric comparison targets. */
export const saturatedMetrics = {
  txSuccesses: 3,
  txFailures: 0,
  envelopeCount: 1,
  envelopeByteSizes: [65_000],
  epochEnvelopeIndexes: [0],
  solanaOversized: false,
  saturated: true
}

/** Successful phase with independent recomputation inputs and targets. */
export const completedPhase = {
  status: RunEvidencePhaseStatus.Completed,
  label: "solana-threshold-probe",
  endpoint: EvidenceEndpoint,
  strategy: RunEvidenceSaturationStrategy.ByteThreshold,
  baseline: {
    ...createEnvelopeBaseline([]),
    observationOrdinal: "40",
    artifactRefs: []
  },
  window: {
    startedAtMs: "18446744073709551617",
    endedAtMs: "18446744073709551619",
    epochStart: "87654320",
    epochEnd: "87654321"
  },
  artifactRefs: [EvidenceDataRef, EvidenceMetadataRef],
  telemetry: healthyTelemetry,
  metrics: saturatedMetrics
}

/** Typed phase breakage with terminal integrity telemetry. */
export const breakagePhase = {
  ...completedPhase,
  status: RunEvidencePhaseStatus.Breakage,
  artifactRefs: [],
  telemetry: degradedTelemetry,
  metrics: {
    ...saturatedMetrics,
    envelopeCount: 0,
    envelopeByteSizes: [],
    epochEnvelopeIndexes: [],
    saturated: false
  },
  breakageCategory: RampBreakageCategory.TelemetryIntegrity,
  breakageReason: "persistent checksum mismatch"
}

/** Saturated completed iteration with explicit endpoint sets. */
export const saturatedIteration = {
  schemaVersion: RunEvidenceSchemaVersion,
  stage: RunEvidenceStage.Iteration,
  iterationIndex: 0,
  accountCount: 3,
  startedAtMs: "18446744073709551617",
  endedAtMs: "18446744073709551620",
  outcome: RunEvidenceIterationOutcome.Saturated,
  requiredEndpoints: [EvidenceEndpoint],
  saturatedEndpoints: [EvidenceEndpoint],
  missingEndpoints: [],
  endpointResults: [
    { endpoint: EvidenceEndpoint, telemetry: healthyTelemetry, saturated: true }
  ],
  telemetry: healthyTelemetry,
  phases: [completedPhase]
}

/** Breakage iteration with typed reason and no false saturation credit. */
export const breakageIteration = {
  ...saturatedIteration,
  outcome: RunEvidenceIterationOutcome.Breakage,
  saturatedEndpoints: [],
  missingEndpoints: [EvidenceEndpoint],
  endpointResults: [
    {
      endpoint: EvidenceEndpoint,
      telemetry: degradedTelemetry,
      saturated: false
    }
  ],
  telemetry: degradedTelemetry,
  phases: [breakagePhase],
  breakageCategory: RampBreakageCategory.TelemetryIntegrity,
  breakageReason: "persistent checksum mismatch"
}

/** Initial manifest allocated before setup. */
export const initializingManifest = {
  schemaVersion: RunEvidenceSchemaVersion,
  runId: "9f1c2a30-8b44-4d55-9a66-123456789abc",
  lifecycle: RunEvidenceLifecycle.Initializing,
  startedAtMs: "18446744073709551615",
  updatedAtMs: "18446744073709551615",
  clusterPath: "/var/tmp/wire-stress-cluster",
  rampConfig: {
    initialCount: 3,
    multiplier: 3,
    maxCount: 243,
    phaseTimeoutMs: 321_000
  },
  requiredEndpoints: [EvidenceEndpoint],
  saturatedEndpoints: [],
  missingEndpoints: [EvidenceEndpoint],
  preserveCluster: true,
  telemetry: emptyTelemetry,
  runtime: { nodeVersion: "v24.8.1", platform: "linux", architecture: "arm64" },
  provenance,
  clusterConfigSnapshot: { kind: RunEvidenceClusterConfigState.Pending },
  records: {
    setup: { kind: RunEvidenceSetupRefState.Pending },
    iterations: [],
    terminal: null
  },
  artifacts: []
}

/** Saturated terminal decision with healthy complete endpoint evidence. */
export const saturatedTerminal = {
  schemaVersion: RunEvidenceSchemaVersion,
  stage: RunEvidenceStage.Terminal,
  lifecycle: RunEvidenceLifecycle.Saturated,
  startedAtMs: "18446744073709551615",
  endedAtMs: "18446744073709551621",
  requiredEndpoints: [EvidenceEndpoint],
  saturatedEndpoints: [EvidenceEndpoint],
  missingEndpoints: [],
  endpointResults: [
    { endpoint: EvidenceEndpoint, telemetry: healthyTelemetry, saturated: true }
  ],
  telemetry: healthyTelemetry,
  iterationRefs: [iterationRecordRef],
  preserveCluster: false
}

/** Return a fixture copy without the named property. */
export function withoutKey(
  input: Readonly<Record<string, unknown>>,
  omittedKey: string
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== omittedKey)
  )
}
