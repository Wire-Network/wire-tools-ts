import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppEnvelopeTelemetryHealthKind,
  RampBreakageCategory,
  RunEvidenceClusterConfigState,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSaturationStrategy,
  RunEvidenceSchemaVersion,
  RunEvidenceSetupRefState,
  RunEvidenceSetupStatus,
  RunEvidenceStage,
  type OppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"

import { verifierFixtureSha256 } from "./runEvidenceVerifierArtifactFixture.js"
import type {
  BuiltVerifierRecords,
  VerifierPhaseSpec
} from "./runEvidenceVerifierFixtureTypes.js"

/** Build the canonical manifest value for a fixture lifecycle. */
export function buildVerifierManifest(input: {
  readonly lifecycle: RunEvidenceLifecycle
  readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  readonly initialCount: number
  readonly maxCount: number
  readonly records: BuiltVerifierRecords
}): unknown {
  return {
    schemaVersion: RunEvidenceSchemaVersion,
    runId: "12345678-1234-4abc-8def-123456789abc",
    lifecycle: input.lifecycle,
    startedAtMs: "100",
    updatedAtMs:
      input.lifecycle === RunEvidenceLifecycle.Initializing ? "100" : "110",
    clusterPath: "/tmp/verifier-cluster",
    rampConfig: {
      initialCount: input.initialCount,
      multiplier: 2,
      maxCount: input.maxCount,
      phaseTimeoutMs: 240_000
    },
    requiredEndpoints: input.requiredEndpoints,
    saturatedEndpoints: input.records.saturatedEndpoints,
    missingEndpoints: input.requiredEndpoints.filter(
      endpoint => !input.records.saturatedEndpoints.includes(endpoint)
    ),
    preserveCluster: input.lifecycle !== RunEvidenceLifecycle.Saturated,
    telemetry: input.records.telemetry,
    runtime: { nodeVersion: "v24.0.0", platform: "linux", architecture: "x64" },
    provenance: {
      wireBuildPath: "/opt/wire/build",
      ethereumPath: "/opt/wire/ethereum",
      solanaPath: "/opt/wire/solana"
    },
    clusterConfigSnapshot: input.records.configSnapshot,
    records: {
      setup: input.records.setupRef,
      iterations: input.records.iterationRefs,
      terminal: input.records.terminalRef
    },
    artifacts: input.records.artifacts
  }
}

/** Return record state for a pre-setup initializing fixture. */
export function initializingVerifierRecords(): BuiltVerifierRecords {
  return {
    setupRef: { kind: RunEvidenceSetupRefState.Pending },
    iterationRefs: [],
    terminalRef: null,
    artifacts: [],
    saturatedEndpoints: [],
    telemetry: emptyFixtureTelemetry(),
    configSnapshot: { kind: RunEvidenceClusterConfigState.Pending }
  }
}

/** Build a successful or failed setup record. */
export function verifierSetupRecord(
  failed: boolean,
  clusterConfigCreated: boolean
): unknown {
  const base = {
    schemaVersion: RunEvidenceSchemaVersion,
    stage: RunEvidenceStage.Setup,
    status: failed
      ? RunEvidenceSetupStatus.Failed
      : RunEvidenceSetupStatus.Succeeded,
    startedAtMs: "101",
    endedAtMs: "102",
    clusterConfigCreated
  }
  return failed
    ? {
        ...base,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: "setup failed"
      }
    : base
}

/** Write and describe one immutable captured config snapshot. */
export function writeVerifierConfig(runDirectory: string): unknown {
  const bytes = Buffer.from('{"cluster":"config"}\n')
  Fs.writeFileSync(
    Path.join(runDirectory, RunEvidencePath.ClusterConfigSnapshot),
    bytes
  )
  return {
    kind: RunEvidenceClusterConfigState.Captured,
    path: RunEvidencePath.ClusterConfigSnapshot,
    sha256: verifierFixtureSha256(bytes)
  }
}

/** Return coherent healthy telemetry for a fixture candidate count. */
export function healthyFixtureTelemetry(count = 1): OppEnvelopeTelemetryHealth {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Healthy,
    retryable: false,
    candidateCount: count,
    validCount: count,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  }
}

/** Return coherent pre-candidate empty telemetry. */
export function emptyFixtureTelemetry(): OppEnvelopeTelemetryHealth {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  }
}

/** Select default threshold phases for one fixture lifecycle. */
export function defaultVerifierPhases(
  lifecycle: RunEvidenceLifecycle,
  endpoints: readonly RunEvidenceEndpoint[]
): readonly VerifierPhaseSpec[] {
  return endpoints.map(endpoint => ({
    endpoint,
    strategy: RunEvidenceSaturationStrategy.ByteThreshold,
    byteSize: lifecycle === RunEvidenceLifecycle.Saturated ? 62_259 : 62_258,
    epochEnvelopeIndex: 0
  }))
}
