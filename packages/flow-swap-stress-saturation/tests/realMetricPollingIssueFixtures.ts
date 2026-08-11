import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryIssue
} from "@wireio/test-flow-swap-stress-saturation/stress-engine/index.js"

import { produceCandidatePollingIssues } from "./pollingCandidateIssueProducers.js"
import { produceRootPollingIssues } from "./pollingRootIssueProducers.js"

/** Observation scope one producer-backed strict issue belongs to. */
export enum PollableIntegrityIssueScopeKind {
  candidate = "candidate",
  storage = "storage"
}

/**
 * Observation scope — derived from {@link PollableIntegrityIssueScopeKind} so
 * the raw spellings stay assignable at fixture sites.
 */
export type PollableIntegrityIssueScope =
  `${PollableIntegrityIssueScopeKind}`

/** One producer-backed strict issue and its observation scope. */
export interface PollableIntegrityIssue {
  readonly name: string
  readonly scope: PollableIntegrityIssueScope
  readonly issue: OppEnvelopeTelemetryIssue
}

/**
 * Obtain all post-baseline issues from real strict-reader producer paths.
 * @returns Twenty-four production-mapped polling fixtures.
 */
export async function producePollableIntegrityIssues(): Promise<
  readonly PollableIntegrityIssue[]
> {
  const issues = [
    ...(await produceCandidatePollingIssues()),
    ...(await produceRootPollingIssues())
  ]
  return issues.map(issue => ({
    name: issue.code,
    scope: issue.baseKey === "$storage" ? "storage" : "candidate",
    issue
  }))
}

/** Strict issues produced before polling begins rather than by a poll snapshot. */
export const NonPollableIntegrityIssueCodes = [
  OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed
] as const
