import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryIssue
} from "@wireio/test-opp-stress"

import { produceCandidatePollingIssues } from "./pollingCandidateIssueProducers.js"
import { produceRootPollingIssues } from "./pollingRootIssueProducers.js"

/** One producer-backed strict issue and its observation scope. */
export type PollableIntegrityIssue = {
  readonly name: string
  readonly scope: "candidate" | "storage"
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
