import type { OppEnvelopeTelemetryIssue } from "./TelemetryIssueTypes.js"

/** Serializable health-state discriminants for strict OPP telemetry. */
export enum OppEnvelopeTelemetryHealthKind {
  /** No candidate envelope has been discovered; the observation remains retryable. */
  Empty = "empty",
  /** At least one discovered candidate remains incomplete or invalid and retryable. */
  PendingPublication = "pending_publication",
  /** Every discovered candidate is valid or intentionally filtered. */
  Healthy = "healthy",
  /** Deadline policy terminalized a persistent empty or pending observation. */
  Degraded = "degraded"
}

/** Candidate-accounting counts shared by non-empty telemetry health states. */
export type OppEnvelopeTelemetryCounts = {
  /** Number of post-baseline candidate base keys discovered. */
  readonly candidateCount: number
  /** Number of candidates that passed strict integrity validation. */
  readonly validCount: number
  /** Number of candidates intentionally excluded by requested metric filters. */
  readonly filteredCount: number
  /** Number of structured issue records carried by this health value. */
  readonly issueCount: number
}

/** Retryable observation made before any candidate envelope is available. */
export type EmptyOppEnvelopeTelemetryHealth = {
  /** Empty-state discriminant. */
  readonly kind: OppEnvelopeTelemetryHealthKind.Empty
  /** Empty observations are retryable before the approved deadline. */
  readonly retryable: true
  /** Empty observations have no discovered candidates. */
  readonly candidateCount: 0
  /** Empty observations have no valid candidates. */
  readonly validCount: 0
  /** Empty observations have no filtered candidates. */
  readonly filteredCount: 0
  /** Number of global scan/baseline issues, equal to `issues.length`. */
  readonly issueCount: number
  /** Zero or more global scan/baseline issues; candidate issues are forbidden. */
  readonly issues: readonly OppEnvelopeTelemetryIssue[]
}

/** Retryable observation containing at least one incomplete or invalid candidate. */
export type PendingOppEnvelopeTelemetryHealth = OppEnvelopeTelemetryCounts & {
  /** Pending-publication discriminant. */
  readonly kind: OppEnvelopeTelemetryHealthKind.PendingPublication
  /** Pending observations are retryable before the approved deadline. */
  readonly retryable: true
  /** Nonempty candidate-specific issues for unaccounted candidates. */
  readonly issues: readonly [
    OppEnvelopeTelemetryIssue,
    ...OppEnvelopeTelemetryIssue[]
  ]
}

/** Complete observation in which every candidate is valid or intentionally filtered. */
export type HealthyOppEnvelopeTelemetryHealth = Omit<
  OppEnvelopeTelemetryCounts,
  "issueCount"
> & {
  /** Healthy-state discriminant. */
  readonly kind: OppEnvelopeTelemetryHealthKind.Healthy
  /** Healthy observations need no retry. */
  readonly retryable: false
  /** Healthy observations carry no issues. */
  readonly issueCount: 0
  /** Healthy observations carry the statically empty issue tuple. */
  readonly issues: readonly []
}

/** Terminal deadline-policy result for a persistent empty or pending observation. */
export type DegradedOppEnvelopeTelemetryHealth = OppEnvelopeTelemetryCounts & {
  /** Degraded-state discriminant. */
  readonly kind: OppEnvelopeTelemetryHealthKind.Degraded
  /** Degraded results are terminal and not retryable. */
  readonly retryable: false
  /** Nonempty persistent global or candidate-specific issues. */
  readonly issues: readonly [
    OppEnvelopeTelemetryIssue,
    ...OppEnvelopeTelemetryIssue[]
  ]
}

/** Collection result before deadline policy; collectors cannot produce degraded health. */
export type OppEnvelopeTelemetryObservation =
  | EmptyOppEnvelopeTelemetryHealth
  | PendingOppEnvelopeTelemetryHealth
  | HealthyOppEnvelopeTelemetryHealth

/** Complete telemetry-health contract including terminal deadline-policy degradation. */
export type OppEnvelopeTelemetryHealth =
  OppEnvelopeTelemetryObservation | DegradedOppEnvelopeTelemetryHealth
