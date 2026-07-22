import {
  OppEnvelopeTelemetryHealthKind,
  type DegradedOppEnvelopeTelemetryHealth,
  type EmptyOppEnvelopeTelemetryHealth,
  type HealthyOppEnvelopeTelemetryHealth,
  type OppEnvelopeTelemetryCounts,
  type OppEnvelopeTelemetryHealth,
  type PendingOppEnvelopeTelemetryHealth
} from "./TelemetryHealthTypes.js"
import {
  isCandidateTelemetryIssue,
  isGlobalTelemetryIssue,
  parseTelemetryIssues,
  requireTelemetryIssues
} from "./telemetryIssueParser.js"
import type { OppEnvelopeTelemetryIssue } from "./TelemetryIssueTypes.js"
import {
  field,
  invalid,
  parseBoolean,
  parseCount,
  parseExactRecord
} from "./telemetryParseSupport.js"

export { OppEnvelopeTelemetryHealthParseError } from "./TelemetryHealthParseError.js"

const HealthKeys = [
    "kind",
    "retryable",
    "candidateCount",
    "validCount",
    "filteredCount",
    "issueCount",
    "issues"
  ] as const,
  HealthKinds = [
    OppEnvelopeTelemetryHealthKind.Empty,
    OppEnvelopeTelemetryHealthKind.PendingPublication,
    OppEnvelopeTelemetryHealthKind.Healthy,
    OppEnvelopeTelemetryHealthKind.Degraded
  ] as const

type ParsedHealth = {
  readonly kind: OppEnvelopeTelemetryHealthKind
  readonly retryable: boolean
  readonly counts: OppEnvelopeTelemetryCounts
  readonly issues: readonly OppEnvelopeTelemetryIssue[]
}

type HealthParser = (parsed: ParsedHealth) => OppEnvelopeTelemetryHealth

const HealthParserByKind = {
  [OppEnvelopeTelemetryHealthKind.Empty]: parseEmpty,
  [OppEnvelopeTelemetryHealthKind.PendingPublication]: parsePending,
  [OppEnvelopeTelemetryHealthKind.Healthy]: parseHealthy,
  [OppEnvelopeTelemetryHealthKind.Degraded]: parseDegraded
} satisfies Record<OppEnvelopeTelemetryHealthKind, HealthParser>

/**
 * Parse unknown JSON data into a coherent OPP envelope telemetry-health value.
 *
 * @param value Unknown value crossing the telemetry persistence boundary.
 * @returns Narrowed health value with variant and count invariants enforced.
 * @throws {@link OppEnvelopeTelemetryHealthParseError} when the value is invalid.
 */
export function parseOppEnvelopeTelemetryHealth(
  value: unknown
): OppEnvelopeTelemetryHealth {
  const record = parseExactRecord(value, HealthKeys, "health"),
    parsed: ParsedHealth = {
      kind: parseHealthKind(field(record, "kind", "health")),
      retryable: parseBoolean(
        field(record, "retryable", "health"),
        "health.retryable"
      ),
      counts: parseCounts(record),
      issues: parseTelemetryIssues(field(record, "issues", "health"))
    }

  if (parsed.counts.issueCount !== parsed.issues.length) {
    throw invalid("health.issueCount", "must equal issues.length")
  }
  if (accountedCount(parsed.counts) > parsed.counts.candidateCount) {
    throw invalid("health", "validCount + filteredCount exceeds candidateCount")
  }

  return HealthParserByKind[parsed.kind](parsed)
}

function parseCounts(record: object): OppEnvelopeTelemetryCounts {
  return {
    candidateCount: parseCount(
      field(record, "candidateCount", "health"),
      "health.candidateCount"
    ),
    validCount: parseCount(
      field(record, "validCount", "health"),
      "health.validCount"
    ),
    filteredCount: parseCount(
      field(record, "filteredCount", "health"),
      "health.filteredCount"
    ),
    issueCount: parseCount(
      field(record, "issueCount", "health"),
      "health.issueCount"
    )
  }
}

function parseEmpty(parsed: ParsedHealth): EmptyOppEnvelopeTelemetryHealth {
  if (!parsed.retryable)
    throw invalid("health.retryable", "empty must be retryable")
  if (!hasEmptyGlobalShape(parsed)) {
    throw invalid(
      "health",
      "empty requires zero candidate counts and only global issues"
    )
  }
  return {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: parsed.counts.issueCount,
    issues: parsed.issues
  }
}

function parsePending(parsed: ParsedHealth): PendingOppEnvelopeTelemetryHealth {
  if (!parsed.retryable)
    throw invalid("health.retryable", "pending publication must be retryable")
  if (!hasPendingCandidateShape(parsed)) {
    throw invalid(
      "health",
      "pending publication requires unaccounted candidates and candidate issues"
    )
  }
  return {
    kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
    retryable: true,
    ...parsed.counts,
    issues: requireTelemetryIssues(parsed.issues)
  }
}

function parseHealthy(parsed: ParsedHealth): HealthyOppEnvelopeTelemetryHealth {
  if (parsed.retryable)
    throw invalid("health.retryable", "healthy cannot be retryable")
  if (
    parsed.counts.candidateCount === 0 ||
    accountedCount(parsed.counts) !== parsed.counts.candidateCount ||
    parsed.issues.length !== 0
  ) {
    throw invalid(
      "health",
      "healthy must account for every candidate without issues"
    )
  }
  return {
    kind: OppEnvelopeTelemetryHealthKind.Healthy,
    retryable: false,
    ...parsed.counts,
    issueCount: 0,
    issues: []
  }
}

function parseDegraded(
  parsed: ParsedHealth
): DegradedOppEnvelopeTelemetryHealth {
  if (parsed.retryable)
    throw invalid("health.retryable", "degraded cannot be retryable")
  const issues = requireTelemetryIssues(parsed.issues)
  if (!hasEmptyGlobalShape(parsed) && !hasPendingCandidateShape(parsed)) {
    throw invalid(
      "health",
      "degraded must terminalize a coherent empty or pending observation"
    )
  }
  return {
    kind: OppEnvelopeTelemetryHealthKind.Degraded,
    retryable: false,
    ...parsed.counts,
    issues
  }
}

function hasEmptyGlobalShape(parsed: ParsedHealth): boolean {
  return (
    parsed.counts.candidateCount === 0 &&
    parsed.counts.validCount === 0 &&
    parsed.counts.filteredCount === 0 &&
    parsed.issues.every(isGlobalTelemetryIssue)
  )
}

function hasPendingCandidateShape(parsed: ParsedHealth): boolean {
  return (
    parsed.counts.candidateCount > 0 &&
    accountedCount(parsed.counts) < parsed.counts.candidateCount &&
    parsed.issues.length > 0 &&
    parsed.issues.every(isCandidateTelemetryIssue)
  )
}

function accountedCount(counts: OppEnvelopeTelemetryCounts): number {
  return counts.validCount + counts.filteredCount
}

function parseHealthKind(value: unknown): OppEnvelopeTelemetryHealthKind {
  if (!isHealthKind(value)) {
    throw invalid("health.kind", "is not a telemetry-health kind")
  }
  return value
}

function isHealthKind(value: unknown): value is OppEnvelopeTelemetryHealthKind {
  return HealthKinds.some(kind => kind === value)
}
