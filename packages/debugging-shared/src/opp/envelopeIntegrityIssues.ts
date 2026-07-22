import * as Path from "node:path"

import { EnvelopeStorageKeyValidationIssue } from "./EnvelopeStorageKey.js"
import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityFileError,
  type EnvelopeIntegrityFileIdentity,
  type EnvelopeIntegrityIssue,
  type EnvelopeIntegrityIssueSequence
} from "./EnvelopeIntegrityReaderTypes.js"
import { unknownErrorMessage } from "./envelopeIntegrityError.js"
import type {
  EnvelopeCandidateValidationRequest,
  EnvelopeCandidateValidationResult
} from "./envelopeIntegrityValidationTypes.js"
import type { StableFileReadResult } from "./envelopeIntegrityFileSystem.js"

const StorageScopeBaseKey = "$storage"

/**
 * Build one normalized storage-root I/O issue.
 * @param storageRoot Resolved storage root.
 * @param path Root component associated with the failure.
 * @param error Normalized filesystem failure.
 * @returns Pin-compatible issue outcome.
 */
export function rootReadIssue(
  storageRoot: string,
  path: string,
  error: EnvelopeIntegrityFileError
): { readonly kind: "issue"; readonly issues: EnvelopeIntegrityIssueSequence } {
  return {
    kind: "issue",
    issues: [
      {
        code: EnvelopeIntegrityIssueCode.StorageRootReadFailed,
        baseKey: StorageScopeBaseKey,
        context: { path: path || storageRoot, error }
      }
    ]
  }
}

/**
 * Build one storage-root identity-change issue.
 * @param storageRoot Resolved storage root.
 * @param before Pinned root identity.
 * @param after Current identity when available.
 * @param error Normalized verification failure when available.
 * @returns Pin-compatible issue outcome.
 */
export function rootChangedIssue(
  storageRoot: string,
  before: EnvelopeIntegrityFileIdentity,
  after: EnvelopeIntegrityFileIdentity | null,
  error: EnvelopeIntegrityFileError | null
): { readonly kind: "issue"; readonly issues: EnvelopeIntegrityIssueSequence } {
  return {
    kind: "issue",
    issues: [
      {
        code: EnvelopeIntegrityIssueCode.StorageRootChanged,
        baseKey: StorageScopeBaseKey,
        context: { path: storageRoot, before, after, error }
      }
    ]
  }
}

/**
 * Create an empty JSON-safe identity when no descriptor was available.
 * @returns Identity with every serialized field empty.
 */
export function emptyFileIdentity(): EnvelopeIntegrityFileIdentity {
  return {
    dev: "",
    ino: "",
    mode: "",
    nlink: "",
    size: "",
    mtimeNs: "",
    ctimeNs: ""
  }
}

/**
 * Resolve one candidate sidecar while enforcing lexical root containment.
 * @param request Candidate key, root, and filesystem state.
 * @param extension Sidecar suffix to resolve.
 * @returns Contained path or a path-escape issue.
 */
export function resolveCandidateSidecarPath(
  request: EnvelopeCandidateValidationRequest,
  extension: string
):
  | { readonly kind: "path"; readonly path: string; readonly basename: string }
  | Extract<EnvelopeCandidateValidationResult, { readonly kind: "issue" }> {
  const basename = `${request.baseKey}${extension}`,
    path = Path.resolve(request.root.path, basename)
  return Path.basename(basename) !== basename ||
    basename === "." ||
    basename === ".."
    ? issue({
        code: EnvelopeIntegrityIssueCode.PathOutsideStorageRoot,
        baseKey: request.baseKey,
        context: { storageRoot: request.root.path, path }
      })
    : { kind: "path", path, basename }
}

/**
 * Convert canonical key validation failure into a reader-local issue.
 * @param baseKey Discovered candidate base key.
 * @param validationIssue Canonical validator failure component.
 * @returns Candidate issue result with correlated context.
 */
export function invalidKeyResult(
  baseKey: string,
  validationIssue: EnvelopeStorageKeyValidationIssue
): EnvelopeCandidateValidationResult {
  if (validationIssue === EnvelopeStorageKeyValidationIssue.Endpoints) {
    return issue({
      code: EnvelopeIntegrityIssueCode.UnknownEndpoint,
      baseKey,
      context: { endpointKey: baseKey.split("-")[1] }
    })
  }
  const reason =
    validationIssue === EnvelopeStorageKeyValidationIssue.Epoch
      ? "invalid_epoch"
      : validationIssue === EnvelopeStorageKeyValidationIssue.Checksum
        ? "invalid_checksum"
        : "noncanonical_format"
  return issue({
    code: EnvelopeIntegrityIssueCode.InvalidStorageKey,
    baseKey,
    context: { filename: baseKey, reason }
  })
}

/**
 * Build one metadata-last pending candidate and its correlated issue.
 * @param baseKey Canonical candidate base key.
 * @param missingSidecar Missing pair member.
 * @param path Expected missing sidecar path.
 * @returns Pending candidate with matching issue.
 */
export function pendingResult(
  baseKey: string,
  missingSidecar: "data" | "metadata",
  path: string
): EnvelopeCandidateValidationResult {
  const code =
    missingSidecar === "data"
      ? EnvelopeIntegrityIssueCode.MissingDataSidecar
      : EnvelopeIntegrityIssueCode.MissingMetadataSidecar
  return {
    kind: "pending",
    value: { baseKey, missingSidecar },
    issue: { code, baseKey, context: { path } }
  }
}

/**
 * Map one stable-read failure to its sidecar-specific issue variant.
 * @param baseKey Canonical candidate base key.
 * @param sidecar Sidecar being validated.
 * @param path Absolute sidecar path.
 * @param result Descriptor-read failure outcome.
 * @returns Sidecar-correlated candidate issue.
 */
export function sidecarReadIssue(
  baseKey: string,
  sidecar: "data" | "metadata",
  path: string,
  result: Exclude<StableFileReadResult, { readonly kind: "bytes" }>
): EnvelopeCandidateValidationResult {
  if (result.kind === "symlink") {
    return issue({
      code:
        sidecar === "data"
          ? EnvelopeIntegrityIssueCode.DataSidecarSymlink
          : EnvelopeIntegrityIssueCode.MetadataSidecarSymlink,
      baseKey,
      context: { path, error: result.error }
    })
  }
  if (result.kind === "not_regular") {
    return issue({
      code:
        sidecar === "data"
          ? EnvelopeIntegrityIssueCode.DataSidecarNotRegular
          : EnvelopeIntegrityIssueCode.MetadataSidecarNotRegular,
      baseKey,
      context: { path }
    })
  }
  if (result.kind === "changed") {
    return issue({
      code:
        sidecar === "data"
          ? EnvelopeIntegrityIssueCode.DataSidecarChanged
          : EnvelopeIntegrityIssueCode.MetadataSidecarChanged,
      baseKey,
      context: {
        path,
        before: result.before,
        after: result.after,
        error: result.error
      }
    })
  }
  return issue({
    code:
      sidecar === "data"
        ? EnvelopeIntegrityIssueCode.DataReadFailed
        : EnvelopeIntegrityIssueCode.MetadataReadFailed,
    baseKey,
    context: { path, error: result.error }
  })
}

/**
 * Map one protobuf decode failure without throwing from collection.
 * @param baseKey Canonical candidate base key.
 * @param code Data or metadata decode issue code.
 * @param path Sidecar path whose bytes failed decoding.
 * @param error Unknown decoder failure.
 * @returns Decode issue with a JSON-safe reason.
 */
export function decodeIssueResult(
  baseKey: string,
  code:
    | EnvelopeIntegrityIssueCode.DataDecodeFailed
    | EnvelopeIntegrityIssueCode.MetadataDecodeFailed,
  path: string,
  error: unknown
): EnvelopeCandidateValidationResult {
  return issue({
    code,
    baseKey,
    context: {
      path,
      reason: unknownErrorMessage(error)
    }
  })
}

function issue(
  value: EnvelopeIntegrityIssue
): Extract<EnvelopeCandidateValidationResult, { readonly kind: "issue" }> {
  return { kind: "issue", issue: value }
}
