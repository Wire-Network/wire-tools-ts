import type {
  EnvelopeIntegrityIssue,
  PendingEnvelopePair,
  ValidEnvelopePair
} from "./EnvelopeIntegrityReaderTypes.js"
import type { PinnedEnvelopeStorageRoot } from "./envelopeIntegrityRootTypes.js"

/** Candidate whose pair validated against every strict integrity rule. */
export interface EnvelopeCandidateValid {
  readonly kind: "valid"
  readonly value: ValidEnvelopePair
}

/** Candidate awaiting its metadata-last publication sidecar. */
export interface EnvelopeCandidatePending {
  readonly kind: "pending"
  readonly value: PendingEnvelopePair
  readonly issue: EnvelopeIntegrityIssue
}

/** Candidate rejected with one correlated diagnostic. */
export interface EnvelopeCandidateIssue {
  readonly kind: "issue"
  readonly issue: EnvelopeIntegrityIssue
}

/** Internal one-candidate validation outcome consumed by the bounded pool. */
export type EnvelopeCandidateValidationResult =
  EnvelopeCandidateValid | EnvelopeCandidatePending | EnvelopeCandidateIssue

/** Inputs shared by one canonical candidate validation. */
export interface EnvelopeCandidateValidationRequest {
  readonly root: PinnedEnvelopeStorageRoot
  readonly baseKey: string
  readonly filenames: ReadonlySet<string>
}
