import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { mapEnvelopeIntegrityIssue } from "./envelopeTelemetryIssueMapper.js"
import {
  MaxEnvelopeBytes,
  SaturatedEnvelopeMinBytes,
  SolanaRawTransactionBytesMax
} from "./envelopeMetricTypes.js"
import type {
  EnvelopeMetricRecord,
  EnvelopeMetricSnapshot,
  MalformedOppEnvelopeRecord,
  OppEnvelopeMetric,
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationStrategy,
  OppEnvelopeSaturationWindow
} from "./envelopeMetricTypes.js"
import {
  OppEnvelopeTelemetryHealthKind,
  type EmptyOppEnvelopeTelemetryHealth,
  type HealthyOppEnvelopeTelemetryHealth,
  type OppEnvelopeTelemetryObservation,
  type PendingOppEnvelopeTelemetryHealth
} from "./TelemetryHealthTypes.js"
import type { OppEnvelopeTelemetryIssue } from "./TelemetryIssueTypes.js"

/**
 * Project one source-agnostic envelope snapshot into OPP saturation metrics.
 *
 * The saturation core shared by every `EnvelopeRecordSource` (filesystem debug
 * artifacts, on-chain RPC, remote debugging-server). It reads only
 * `record.dataBytes.byteLength` and the record's key fields, so no source has
 * to supply filesystem-only provenance.
 *
 * @param snapshot Confirmed records plus candidate/issue accounting.
 * @param window Endpoint, epoch, and saturation filters.
 * @returns Deterministic metrics with coherent candidate health.
 */
export function projectSnapshotSaturationMetrics(
  snapshot: EnvelopeMetricSnapshot,
  window: OppEnvelopeSaturationWindow = {}
): OppEnvelopeSaturationMetrics {
  const issues = snapshot.issues.map(mapEnvelopeIntegrityIssue)
  if (snapshot.kind === "source_failed") {
    return metricsFor([], emptyHealth(issues), window)
  }
  const envelopes = snapshot.records
      .filter(record => matchesWindow(record, window))
      .map(projectMetric)
      .sort(compareEnvelopeMetrics),
    health = observationHealth(snapshot, envelopes.length, issues)
  return metricsFor(envelopes, health, window)
}

function projectMetric(record: EnvelopeMetricRecord): OppEnvelopeMetric {
  const byteSize = record.dataBytes.byteLength
  return {
    key: record.baseKey,
    epoch: record.epochIndex,
    endpointsType: record.endpointsType,
    checksum: record.checksum,
    epochEnvelopeIndex: record.epochEnvelopeIndex,
    byteSize,
    saturationRatio: byteSize / MaxEnvelopeBytes,
    batchOpNames: record.batchOpNames
  }
}

function matchesWindow(
  record: EnvelopeMetricRecord,
  window: OppEnvelopeSaturationWindow
): boolean {
  if (window.epochStart !== undefined && record.epochIndex < window.epochStart)
    return false
  if (window.epochEnd !== undefined && record.epochIndex > window.epochEnd)
    return false
  return (
    window.endpointsType === undefined ||
    window.endpointsType === DebugOutpostEndpointsType.UNKNOWN ||
    record.endpointsType === window.endpointsType
  )
}

function observationHealth(
  snapshot: EnvelopeMetricSnapshot,
  validCount: number,
  issues: readonly OppEnvelopeTelemetryIssue[]
): OppEnvelopeTelemetryObservation {
  const candidateCount = snapshot.candidateCount,
    filteredCount = snapshot.records.length - validCount
  if (candidateCount === 0) return emptyHealth(issues)
  const [firstIssue, ...remainingIssues] = issues
  if (firstIssue !== undefined) {
    return {
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      retryable: true,
      candidateCount,
      validCount,
      filteredCount,
      issueCount: issues.length,
      issues: [firstIssue, ...remainingIssues]
    } satisfies PendingOppEnvelopeTelemetryHealth
  }
  return {
    kind: OppEnvelopeTelemetryHealthKind.Healthy,
    retryable: false,
    candidateCount,
    validCount,
    filteredCount,
    issueCount: 0,
    issues: []
  } satisfies HealthyOppEnvelopeTelemetryHealth
}

function emptyHealth(
  issues: readonly OppEnvelopeTelemetryIssue[]
): EmptyOppEnvelopeTelemetryHealth {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: issues.length,
    issues
  }
}

function metricsFor(
  envelopes: readonly OppEnvelopeMetric[],
  health: OppEnvelopeTelemetryObservation,
  window: OppEnvelopeSaturationWindow
): OppEnvelopeSaturationMetrics {
  return {
    saturated:
      health.kind === OppEnvelopeTelemetryHealthKind.Healthy &&
      saturatedByStrategy(window.saturationStrategy ?? "rollover", envelopes),
    solanaOversized: envelopes.some(
      envelope =>
        envelope.endpointsType ===
          DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA &&
        envelope.byteSize > SolanaRawTransactionBytesMax
    ),
    envelopeCount: envelopes.length,
    byteSizes: envelopes.map(envelope => envelope.byteSize),
    epochEnvelopeIndexes: envelopes.map(
      envelope => envelope.epochEnvelopeIndex
    ),
    envelopes,
    health,
    malformedRecords: malformedRecords(health)
  }
}

function malformedRecords(
  health: OppEnvelopeTelemetryObservation
): readonly MalformedOppEnvelopeRecord[] {
  return health.kind === OppEnvelopeTelemetryHealthKind.PendingPublication
    ? health.issues.map(issue => ({
        key: issue.baseKey,
        reason: issue.code,
        issue
      }))
    : []
}

function saturatedByStrategy(
  strategy: OppEnvelopeSaturationStrategy,
  envelopes: readonly OppEnvelopeMetric[]
): boolean {
  switch (strategy) {
    case "rollover":
      return envelopes.some(envelope => envelope.epochEnvelopeIndex > 0)
    case "byte_threshold":
      return envelopes.some(
        envelope => envelope.byteSize >= SaturatedEnvelopeMinBytes
      )
    default:
      return assertNever(strategy)
  }
}

function compareEnvelopeMetrics(
  left: OppEnvelopeMetric,
  right: OppEnvelopeMetric
): number {
  return (
    left.epoch - right.epoch ||
    left.epochEnvelopeIndex - right.epochEnvelopeIndex ||
    (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  )
}

function assertNever(value: never): never {
  throw new Error(`Unexpected OPP envelope strategy: ${String(value)}`)
}
