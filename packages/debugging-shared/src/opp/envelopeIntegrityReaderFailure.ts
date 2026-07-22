import type {
  EnvelopeBaselineCaptureResult,
  EnvelopeIntegrityIssue,
  EnvelopeIntegrityIssueSequence,
  EnvelopeIntegrityResult
} from "./EnvelopeIntegrityReaderTypes.js"
import { closeEnvelopeStorageRoot } from "./envelopeIntegrityRoot.js"
import type { PinnedEnvelopeStorageRoot } from "./envelopeIntegrityRootTypes.js"

/**
 * Compose existing, initiating, and root-close diagnostics in deterministic order.
 * @param root Retained root whose close completes the reader path.
 * @param existingIssues Candidate diagnostics produced before the terminal failure.
 * @param initiatingIssues Diagnostics that initiated root closure.
 * @returns Existing issues, then initiating issues, then a close issue when present.
 */
export async function closeEnvelopeReaderIssues(
  root: PinnedEnvelopeStorageRoot,
  existingIssues: readonly EnvelopeIntegrityIssue[],
  initiatingIssues: EnvelopeIntegrityIssueSequence
): Promise<EnvelopeIntegrityIssueSequence>
export async function closeEnvelopeReaderIssues(
  root: PinnedEnvelopeStorageRoot,
  existingIssues: readonly EnvelopeIntegrityIssue[],
  initiatingIssues: readonly EnvelopeIntegrityIssue[]
): Promise<readonly EnvelopeIntegrityIssue[]>
export async function closeEnvelopeReaderIssues(
  root: PinnedEnvelopeStorageRoot,
  existingIssues: readonly EnvelopeIntegrityIssue[],
  initiatingIssues: readonly EnvelopeIntegrityIssue[]
): Promise<readonly EnvelopeIntegrityIssue[]> {
  const closeIssue = await closeEnvelopeStorageRoot(root)
  return [
    ...existingIssues,
    ...initiatingIssues,
    ...(closeIssue === null ? [] : [closeIssue])
  ]
}

/**
 * Build one failed baseline result from a non-empty issue sequence.
 * @param issues Ordered baseline failure diagnostics.
 * @returns Failed baseline result.
 */
export function baselineFailure(
  issues: EnvelopeIntegrityIssueSequence
): EnvelopeBaselineCaptureResult {
  return { kind: "failed", issues }
}

/**
 * Build one terminal collection result from ordered issues.
 * @param issues Ordered collection failure diagnostics.
 * @param candidates Candidate keys discovered before failure.
 * @returns Scan-failed collection result.
 */
export function rootFailure(
  issues: EnvelopeIntegrityIssueSequence,
  candidates: readonly string[] = []
): EnvelopeIntegrityResult {
  return {
    kind: "scan_failed",
    candidates,
    valid: [],
    pending: [],
    issues
  }
}

/**
 * Refine a possibly empty readonly issue list into its typed non-empty form.
 * @param issues Ordered diagnostics.
 * @returns Non-empty issue sequence or null.
 */
export function nonEmptyIssues(
  issues: readonly EnvelopeIntegrityIssue[]
): EnvelopeIntegrityIssueSequence | null {
  const [first, ...rest] = issues
  return first === undefined ? null : [first, ...rest]
}

/**
 * Place existing candidate issues before one non-empty terminal sequence.
 * @param existingIssues Candidate diagnostics already in deterministic order.
 * @param issues Terminal issue sequence.
 * @returns One non-empty candidate-first sequence.
 */
export function prependIssues(
  existingIssues: readonly EnvelopeIntegrityIssue[],
  issues: EnvelopeIntegrityIssueSequence
): EnvelopeIntegrityIssueSequence {
  return existingIssues.reduceRight<EnvelopeIntegrityIssueSequence>(
    (ordered, issue) => [issue, ...ordered],
    issues
  )
}
