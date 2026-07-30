import { match } from "ts-pattern"
import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryHealthParseError,
  parseOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import type {
  MalformedOppEnvelopeRecord,
  OppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryIssue
} from "@wireio/test-opp-stress"

import {
  hasExactObservationKeys,
  isObservationRecord,
  isObservationString,
  observationValuesEqual
} from "./observationParserSupport.js"

/**
 * Parsed telemetry health, or `null` when the public parser rejected the
 * candidate. This package compiles with `strictNullChecks`, so the nullable
 * leg is a load-bearing part of the contract and is named rather than spelled
 * inline at the return position.
 */
type ParsedOppEnvelopeTelemetryHealth = OppEnvelopeTelemetryHealth | null

/**
 * Parse exact OPP telemetry health, or return null for a known parse failure.
 *
 * Generic over any OPP telemetry observation (no swap-scenario coupling), so it
 * is shared by both the phase-result and telemetry-degradation validators.
 *
 * @param value Unknown telemetry health candidate.
 * @returns Parsed health, or null when the public parser rejects it.
 */
export function parsedHealth(
  value: unknown
): ParsedOppEnvelopeTelemetryHealth {
  try {
    return parseOppEnvelopeTelemetryHealth(value)
  } catch (error) {
    if (error instanceof OppEnvelopeTelemetryHealthParseError) return null
    throw error
  }
}

/**
 * Validate exact malformed records against the parsed health issue set.
 *
 * Generic over any OPP telemetry health (no swap-scenario coupling).
 *
 * @param value Unknown malformed-record collection.
 * @param health Parsed canonical health owning the issue set.
 * @returns Whether each record exactly mirrors one health issue.
 */
export function isMalformedRecords(
  value: unknown,
  health: OppEnvelopeTelemetryHealth
): value is readonly MalformedOppEnvelopeRecord[] {
  const issues: readonly OppEnvelopeTelemetryIssue[] = health.issues
  if (!Array.isArray(value)) return false
  // `null` marks the one kind (PendingPublication) whose records are compared
  // against the issue set below; every other kind resolves here.
  const kindResult = match(health.kind)
    .with(OppEnvelopeTelemetryHealthKind.PendingPublication, () => null)
    .with(
      OppEnvelopeTelemetryHealthKind.Empty,
      OppEnvelopeTelemetryHealthKind.Healthy,
      OppEnvelopeTelemetryHealthKind.Degraded,
      () => value.length === 0
    )
    .otherwise(kind => assertNeverHealth(kind))
  if (kindResult !== null) return kindResult
  if (value.length !== issues.length) return false
  const unmatchedIssues = [...issues]
  return value.every(record => {
    if (
      !isObservationRecord(record) ||
      !hasExactObservationKeys(record, ["key", "reason", "issue"]) ||
      typeof record.key !== "string" ||
      !isObservationString(record.reason)
    )
      return false
    const issueIndex = unmatchedIssues.findIndex(
      issue =>
        issue.baseKey === record.key &&
        issue.code === record.reason &&
        observationValuesEqual(issue, record.issue)
    )
    if (issueIndex < 0) return false
    unmatchedIssues.splice(issueIndex, 1)
    return true
  })
}

function assertNeverHealth(value: never): never {
  throw new TypeError(`Unexpected malformed-record health: ${String(value)}`)
}
