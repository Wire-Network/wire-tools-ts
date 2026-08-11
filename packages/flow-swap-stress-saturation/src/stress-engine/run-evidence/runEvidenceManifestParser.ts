import { OppEnvelopeTelemetryHealthKind } from "../envelopeMetricTypes.js"
import {
  RunEvidenceClusterConfigState,
  RunEvidenceLifecycle,
  RunEvidenceRecordKind,
  RunEvidenceSchemaVersion
} from "./runEvidenceConstants.js"
import { isArtifactEntries, isProvenance } from "./runEvidenceArtifactGuards.js"
import type { RunEvidenceParseResult } from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import {
  hasConsistentEndpointSets,
  isAbsoluteNormalizedPath,
  isClusterConfigSnapshot,
  isEndpointSet,
  isExactRecord,
  isLifecycle,
  isNonEmptyString,
  isOptionalEndpointSet,
  isOrderedDecimals,
  isPendingSetupRef,
  isRampConfig,
  isRecordRefs,
  isRuntime,
  isSetupRecordRef,
  isTelemetryHealth,
  isTerminalRecordRef,
  parseEvidence
} from "./runEvidenceGuards.js"

const ManifestKeys = [
  "schemaVersion",
  "runId",
  "lifecycle",
  "startedAtMs",
  "updatedAtMs",
  "clusterPath",
  "rampConfig",
  "requiredEndpoints",
  "saturatedEndpoints",
  "missingEndpoints",
  "preserveCluster",
  "telemetry",
  "runtime",
  "provenance",
  "clusterConfigSnapshot",
  "records",
  "artifacts"
]

/**
 * Parse an unknown value as a schema-v1 run manifest.
 * @param input Unknown boundary value to parse.
 * @returns Typed success with the manifest or a stable parse failure.
 */
export function parseRunEvidenceManifest(
  input: unknown
): RunEvidenceParseResult<RunEvidenceManifest> {
  return parseEvidence(input, RunEvidenceRecordKind.Manifest, isManifest)
}

function isManifest(value: unknown): value is RunEvidenceManifest {
  if (
    !isExactRecord(value, ManifestKeys) ||
    value.schemaVersion !== RunEvidenceSchemaVersion ||
    !isNonEmptyString(value.runId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.runId
    ) ||
    !isLifecycle(value.lifecycle) ||
    !isOrderedDecimals(value.startedAtMs, value.updatedAtMs) ||
    !isAbsoluteNormalizedPath(value.clusterPath) ||
    !isRampConfig(value.rampConfig) ||
    !isEndpointSet(value.requiredEndpoints) ||
    !isOptionalEndpointSet(value.saturatedEndpoints) ||
    !isOptionalEndpointSet(value.missingEndpoints) ||
    typeof value.preserveCluster !== "boolean" ||
    !isTelemetryHealth(value.telemetry) ||
    !isRuntime(value.runtime) ||
    !isProvenance(value.provenance) ||
    !isClusterConfigSnapshot(value.clusterConfigSnapshot) ||
    !isRecordRefs(value.records) ||
    !isArtifactEntries(value.artifacts) ||
    !hasConsistentEndpointSets(
      value.requiredEndpoints,
      value.saturatedEndpoints,
      value.missingEndpoints
    )
  )
    return false
  if (value.lifecycle === RunEvidenceLifecycle.Initializing)
    return (
      value.clusterConfigSnapshot.kind ===
        RunEvidenceClusterConfigState.Pending &&
      isPendingSetupRef(value.records.setup) &&
      value.records.iterations.length === 0 &&
      value.records.terminal === null &&
      value.artifacts.length === 0 &&
      value.saturatedEndpoints.length === 0 &&
      value.preserveCluster &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Empty
    )
  if (value.lifecycle === RunEvidenceLifecycle.SetupFailed)
    return (
      value.clusterConfigSnapshot.kind !==
        RunEvidenceClusterConfigState.Pending &&
      isSetupRecordRef(value.records.setup) &&
      value.records.iterations.length === 0 &&
      isTerminalRecordRef(value.records.terminal) &&
      value.artifacts.length === 0 &&
      value.saturatedEndpoints.length === 0 &&
      value.preserveCluster
    )
  if (
    value.clusterConfigSnapshot.kind !==
      RunEvidenceClusterConfigState.Captured ||
    !isSetupRecordRef(value.records.setup)
  )
    return false
  if (value.lifecycle === RunEvidenceLifecycle.Running)
    return (
      value.records.terminal === null &&
      value.missingEndpoints.length > 0 &&
      value.preserveCluster &&
      value.telemetry.kind !== OppEnvelopeTelemetryHealthKind.Degraded
    )
  if (!isTerminalRecordRef(value.records.terminal)) return false
  if (value.lifecycle === RunEvidenceLifecycle.Saturated)
    return (
      value.missingEndpoints.length === 0 &&
      !value.preserveCluster &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy
    )
  if (value.lifecycle === RunEvidenceLifecycle.Incomplete)
    return (
      value.missingEndpoints.length > 0 &&
      value.preserveCluster &&
      value.telemetry.kind === OppEnvelopeTelemetryHealthKind.Healthy
    )
  return (
    value.lifecycle === RunEvidenceLifecycle.Failed && value.preserveCluster
  )
}
