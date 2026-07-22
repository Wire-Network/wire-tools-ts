import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityIssue
} from "@wireio/debugging-shared"

import {
  hasExactObservationKeys,
  isObservationCount,
  isObservationDecimal,
  isObservationRecord,
  isObservationString
} from "./flowObservationParserSupport.js"

const FileOperations = [
  "readdir",
  "open",
  "stat_before_read",
  "read",
  "stat_after_read",
  "verify_open",
  "verify_stat",
  "close",
  "ancestor_lstat",
  "root_lstat",
  "root_realpath",
  "root_open",
  "root_stat",
  "root_verify_open",
  "root_verify_stat",
  "root_close"
] as const

/**
 * Validate every exact structured baseline-integrity issue context.
 * @param value Unknown baseline issue candidate.
 * @returns Whether code, base key, and code-specific context are exact.
 */
export function isEnvelopeIntegrityIssue(
  value: unknown
): value is EnvelopeIntegrityIssue {
  if (
    !isObservationRecord(value) ||
    !hasExactObservationKeys(value, ["code", "baseKey", "context"]) ||
    !isObservationString(value.baseKey) ||
    !isObservationRecord(value.context)
  )
    return false
  const context = value.context
  switch (value.code) {
    case EnvelopeIntegrityIssueCode.InvalidStorageKey:
      return (
        hasExactObservationKeys(context, ["filename", "reason"]) &&
        isObservationString(context.filename) &&
        (context.reason === "noncanonical_format" ||
          context.reason === "invalid_epoch" ||
          context.reason === "invalid_checksum")
      )
    case EnvelopeIntegrityIssueCode.UnknownEndpoint:
      return exactStringContext(context, "endpointKey")
    case EnvelopeIntegrityIssueCode.MissingDataSidecar:
    case EnvelopeIntegrityIssueCode.MissingMetadataSidecar:
    case EnvelopeIntegrityIssueCode.DataSidecarNotRegular:
    case EnvelopeIntegrityIssueCode.MetadataSidecarNotRegular:
    case EnvelopeIntegrityIssueCode.StorageRootSymlink:
    case EnvelopeIntegrityIssueCode.StorageAncestorSymlink:
    case EnvelopeIntegrityIssueCode.StorageRootNotDirectory:
      return exactStringContext(context, "path")
    case EnvelopeIntegrityIssueCode.DataSidecarSymlink:
    case EnvelopeIntegrityIssueCode.MetadataSidecarSymlink:
    case EnvelopeIntegrityIssueCode.DataReadFailed:
    case EnvelopeIntegrityIssueCode.MetadataReadFailed:
    case EnvelopeIntegrityIssueCode.StorageRootReadFailed:
      return (
        hasExactObservationKeys(context, ["path", "error"]) &&
        isObservationString(context.path) &&
        isFileError(context.error)
      )
    case EnvelopeIntegrityIssueCode.DataSidecarChanged:
    case EnvelopeIntegrityIssueCode.MetadataSidecarChanged:
      return (
        hasExactObservationKeys(context, [
          "path",
          "before",
          "after",
          "error"
        ]) &&
        isObservationString(context.path) &&
        isFileIdentity(context.before) &&
        (context.after === null || isFileIdentity(context.after)) &&
        (context.error === null || isFileError(context.error))
      )
    case EnvelopeIntegrityIssueCode.StorageRootChanged:
      return (
        hasExactObservationKeys(context, [
          "path",
          "before",
          "after",
          "error"
        ]) &&
        isObservationString(context.path) &&
        (isFileIdentity(context.before) ||
          isEmptyFileIdentity(context.before)) &&
        (context.after === null || isFileIdentity(context.after)) &&
        (context.error === null || isFileError(context.error))
      )
    case EnvelopeIntegrityIssueCode.DataDecodeFailed:
    case EnvelopeIntegrityIssueCode.MetadataDecodeFailed:
      return (
        hasExactObservationKeys(context, ["path", "reason"]) &&
        isObservationString(context.path) &&
        isObservationString(context.reason)
      )
    case EnvelopeIntegrityIssueCode.DataHashMismatch:
      return exactStrings(context, [
        "expectedHashPrefix",
        "actualHashPrefix",
        "actualSha256"
      ])
    case EnvelopeIntegrityIssueCode.MetadataChecksumMismatch:
      return exactStrings(context, ["expectedChecksum", "actualChecksum"])
    case EnvelopeIntegrityIssueCode.EpochMismatch:
      return (
        hasExactObservationKeys(context, ["keyEpoch", "decodedEpoch"]) &&
        isObservationCount(context.keyEpoch) &&
        isObservationCount(context.decodedEpoch)
      )
    case EnvelopeIntegrityIssueCode.PathOutsideStorageRoot:
      return exactStrings(context, ["storageRoot", "path"])
    case EnvelopeIntegrityIssueCode.BaselineCaptureFailed:
    case EnvelopeIntegrityIssueCode.DirectoryScanFailed:
      return (
        hasExactObservationKeys(context, ["storageDir", "error"]) &&
        isObservationString(context.storageDir) &&
        isFileError(context.error)
      )
    default:
      return false
  }
}

function isFileError(value: unknown): boolean {
  return (
    isObservationRecord(value) &&
    hasExactObservationKeys(value, ["name", "code", "message", "operation"]) &&
    isObservationString(value.name) &&
    (value.code === null || typeof value.code === "string") &&
    typeof value.message === "string" &&
    FileOperations.some(operation => operation === value.operation)
  )
}

function isFileIdentity(value: unknown): boolean {
  return (
    isObservationRecord(value) &&
    hasExactObservationKeys(value, [
      "dev",
      "ino",
      "mode",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs"
    ]) &&
    isObservationDecimal(value.dev) &&
    isObservationDecimal(value.ino) &&
    isObservationDecimal(value.mode) &&
    isObservationDecimal(value.nlink) &&
    isObservationDecimal(value.size) &&
    isObservationDecimal(value.mtimeNs) &&
    isObservationDecimal(value.ctimeNs)
  )
}

function isEmptyFileIdentity(value: unknown): boolean {
  return (
    isObservationRecord(value) &&
    hasExactObservationKeys(value, [
      "dev",
      "ino",
      "mode",
      "nlink",
      "size",
      "mtimeNs",
      "ctimeNs"
    ]) &&
    Object.values(value).every(field => field === "")
  )
}

function exactStringContext(
  value: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  return (
    hasExactObservationKeys(value, [key]) && isObservationString(value[key])
  )
}

function exactStrings(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  return (
    hasExactObservationKeys(value, keys) &&
    keys.every(key => isObservationString(value[key]))
  )
}
