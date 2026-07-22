import type {
  EnvelopeIntegrityDirectoryHandle,
  EnvelopeIntegrityFileIdentity,
  EnvelopeIntegrityIssueSequence
} from "./EnvelopeIntegrityReaderTypes.js"

/** Retained descriptor and identity for one physical storage root. */
export type PinnedEnvelopeStorageRoot = {
  readonly path: string
  readonly identity: EnvelopeIntegrityFileIdentity
  readonly components: readonly RootComponentIdentity[]
  readonly handle: EnvelopeIntegrityDirectoryHandle
}

/** Stable pathname identity retained for one root component. */
export type RootComponentIdentity = {
  readonly path: string
  readonly identity: EnvelopeIntegrityFileIdentity
}

/** Result of pinning a non-symlink storage root. */
export type PinEnvelopeStorageRootResult =
  | { readonly kind: "pinned"; readonly root: PinnedEnvelopeStorageRoot }
  | { readonly kind: "issue"; readonly issues: EnvelopeIntegrityIssueSequence }
