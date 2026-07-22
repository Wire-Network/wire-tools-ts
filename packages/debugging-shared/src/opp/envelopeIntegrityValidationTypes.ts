import type {
  EnvelopeIntegrityIssue,
  PendingEnvelopePair,
  ValidEnvelopePair
} from "./EnvelopeIntegrityReaderTypes.js"
import type { PinnedEnvelopeStorageRoot } from "./envelopeIntegrityRootTypes.js"

/** Internal one-candidate validation outcome consumed by the bounded pool. */
export type EnvelopeCandidateValidationResult =
  | { readonly kind: "valid"; readonly value: ValidEnvelopePair }
  | {
      readonly kind: "pending"
      readonly value: PendingEnvelopePair
      readonly issue: EnvelopeIntegrityIssue
    }
  | { readonly kind: "issue"; readonly issue: EnvelopeIntegrityIssue }

/** Inputs shared by one canonical candidate validation. */
export type EnvelopeCandidateValidationRequest = {
  readonly root: PinnedEnvelopeStorageRoot
  readonly baseKey: string
  readonly filenames: ReadonlySet<string>
}
