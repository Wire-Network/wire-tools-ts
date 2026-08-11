import type {
  EnvelopeIntegrityDirectoryHandle,
  EnvelopeIntegrityFileIdentity,
  EnvelopeIntegrityIssueSequence
} from "./EnvelopeIntegrityReaderTypes.js"

/** Retained descriptor and identity for one physical storage root. */
export interface PinnedEnvelopeStorageRoot {
  readonly path: string
  readonly identity: EnvelopeIntegrityFileIdentity
  readonly components: readonly RootComponentIdentity[]
  readonly handle: EnvelopeIntegrityDirectoryHandle
}

/** Stable pathname identity retained for one root component. */
export interface RootComponentIdentity {
  readonly path: string
  readonly identity: EnvelopeIntegrityFileIdentity
}

/** Storage root pinned to a verified non-symlink physical directory. */
export interface PinnedEnvelopeStorageRootResult {
  readonly kind: "pinned"
  readonly root: PinnedEnvelopeStorageRoot
}

/** Storage root rejected with ordered containment diagnostics. */
export interface EnvelopeStorageRootIssueResult {
  readonly kind: "issue"
  readonly issues: EnvelopeIntegrityIssueSequence
}

/** Result of pinning a non-symlink storage root. */
export type PinEnvelopeStorageRootResult =
  PinnedEnvelopeStorageRootResult | EnvelopeStorageRootIssueResult
