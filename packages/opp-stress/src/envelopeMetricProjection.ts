import type {
  EnvelopeIntegrityResult,
  ValidEnvelopePair
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { mapEnvelopeIntegrityIssue } from "./envelopeTelemetryIssueMapper.js"
import {
  MaxEnvelopeBytes,
  SaturatedEnvelopeMinBytes,
  SolanaRawTransactionBytesMax
} from "./envelopeMetricTypes.js"
import type {
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
 * Project one confirmed strict-reader snapshot into OPP saturation metrics.
 *
 * @param result Confirmed strict-reader snapshot.
 * @param window Endpoint, epoch, and saturation filters.
 * @returns Deterministic metrics with coherent candidate health.
 */
export function projectOppEnvelopeSaturationMetrics(
  result: EnvelopeIntegrityResult,
  window: OppEnvelopeSaturationWindow = {}
): OppEnvelopeSaturationMetrics {
  const issues = result.issues.map(mapEnvelopeIntegrityIssue)
  if (result.kind === "scan_failed") {
    return metricsFor([], emptyHealth(issues), window)
  }
  const envelopes = result.valid
      .filter(pair => matchesWindow(pair, window))
      .map(projectMetric)
      .sort(compareEnvelopeMetrics),
    health = observationHealth(result, envelopes.length, issues)
  return metricsFor(envelopes, health, window)
}

function projectMetric(pair: ValidEnvelopePair): OppEnvelopeMetric {
  const byteSize = pair.dataBytes.byteLength
  return {
    key: pair.baseKey,
    epoch: pair.epochIndex,
    endpointsType: pair.endpointsType,
    checksum: pair.checksum,
    epochEnvelopeIndex: pair.epochEnvelopeIndex,
    byteSize,
    saturationRatio: byteSize / MaxEnvelopeBytes,
    batchOpNames: pair.batchOpNames
  }
}

function matchesWindow(
  pair: ValidEnvelopePair,
  window: OppEnvelopeSaturationWindow
): boolean {
  if (window.epochStart !== undefined && pair.epochIndex < window.epochStart)
    return false
  if (window.epochEnd !== undefined && pair.epochIndex > window.epochEnd)
    return false
  return (
    window.endpointsType === undefined ||
    window.endpointsType === DebugOutpostEndpointsType.UNKNOWN ||
    pair.endpointsType === window.endpointsType
  )
}

function observationHealth(
  result: Extract<EnvelopeIntegrityResult, { readonly kind: "collected" }>,
  validCount: number,
  issues: readonly OppEnvelopeTelemetryIssue[]
): OppEnvelopeTelemetryObservation {
  const candidateCount = result.candidates.length,
    filteredCount = result.valid.length - validCount
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
