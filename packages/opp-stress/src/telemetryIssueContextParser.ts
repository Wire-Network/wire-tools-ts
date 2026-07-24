import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryFileOperation
} from "./TelemetryIssueTypes.js"
import { field, isCount, isExactRecord } from "./telemetryParseSupport.js"

type IssueContextValidator = (value: unknown) => boolean

const FileOperationByName = {
    readdir: true,
    open: true,
    stat_before_read: true,
    read: true,
    stat_after_read: true,
    verify_open: true,
    verify_stat: true,
    close: true,
    ancestor_lstat: true,
    root_lstat: true,
    root_realpath: true,
    root_open: true,
    root_stat: true,
    root_verify_open: true,
    root_verify_stat: true,
    root_close: true
  } satisfies Record<OppEnvelopeTelemetryFileOperation, true>,
  IssueContextValidatorByCode = {
    [OppEnvelopeTelemetryIssueCode.InvalidStorageKey]: isInvalidKeyContext,
    [OppEnvelopeTelemetryIssueCode.UnknownEndpoint]: (value: unknown) =>
      hasStringFields(value, ["endpointKey"]),
    [OppEnvelopeTelemetryIssueCode.MissingDataSidecar]: isPathContext,
    [OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar]: isPathContext,
    [OppEnvelopeTelemetryIssueCode.DataSidecarSymlink]: isReadContext,
    [OppEnvelopeTelemetryIssueCode.MetadataSidecarSymlink]: isReadContext,
    [OppEnvelopeTelemetryIssueCode.DataSidecarNotRegular]: isPathContext,
    [OppEnvelopeTelemetryIssueCode.MetadataSidecarNotRegular]: isPathContext,
    [OppEnvelopeTelemetryIssueCode.DataReadFailed]: isReadContext,
    [OppEnvelopeTelemetryIssueCode.MetadataReadFailed]: isReadContext,
    [OppEnvelopeTelemetryIssueCode.DataSidecarChanged]: isChangedContext,
    [OppEnvelopeTelemetryIssueCode.MetadataSidecarChanged]: isChangedContext,
    [OppEnvelopeTelemetryIssueCode.DataDecodeFailed]: isDecodeContext,
    [OppEnvelopeTelemetryIssueCode.MetadataDecodeFailed]: isDecodeContext,
    [OppEnvelopeTelemetryIssueCode.DataHashMismatch]: (value: unknown) =>
      hasStringFields(value, [
        "expectedHashPrefix",
        "actualHashPrefix",
        "actualSha256"
      ]),
    [OppEnvelopeTelemetryIssueCode.MetadataChecksumMismatch]: (
      value: unknown
    ) => hasStringFields(value, ["expectedChecksum", "actualChecksum"]),
    [OppEnvelopeTelemetryIssueCode.EpochMismatch]: isEpochContext,
    [OppEnvelopeTelemetryIssueCode.PathOutsideStorageRoot]: (value: unknown) =>
      hasStringFields(value, ["storageRoot", "path"]),
    [OppEnvelopeTelemetryIssueCode.StorageRootSymlink]: isPathContext,
    [OppEnvelopeTelemetryIssueCode.StorageAncestorSymlink]: isPathContext,
    [OppEnvelopeTelemetryIssueCode.StorageRootNotDirectory]: isPathContext,
    [OppEnvelopeTelemetryIssueCode.StorageRootChanged]: isChangedContext,
    [OppEnvelopeTelemetryIssueCode.StorageRootReadFailed]: isReadContext,
    [OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed]:
      isStorageErrorContext,
    [OppEnvelopeTelemetryIssueCode.DirectoryScanFailed]: isStorageErrorContext
  } satisfies Record<OppEnvelopeTelemetryIssueCode, IssueContextValidator>

/**
 * Validate the exact context shape correlated with one telemetry issue code.
 *
 * @param code Closed telemetry issue code.
 * @param value Unknown context value.
 * @returns Whether the value exactly matches the code-correlated context.
 */
export function isTelemetryIssueContext(
  code: OppEnvelopeTelemetryIssueCode,
  value: unknown
): boolean {
  return IssueContextValidatorByCode[code](value)
}

function isInvalidKeyContext(value: unknown): boolean {
  if (!isExactRecord(value, ["filename", "reason"])) return false
  const reason = field(value, "reason", "context")
  return (
    typeof field(value, "filename", "context") === "string" &&
    (reason === "noncanonical_format" ||
      reason === "invalid_epoch" ||
      reason === "invalid_checksum")
  )
}

function isPathContext(value: unknown): boolean {
  return hasStringFields(value, ["path"])
}

function isReadContext(value: unknown): boolean {
  return (
    isExactRecord(value, ["path", "error"]) &&
    typeof field(value, "path", "context") === "string" &&
    isFileError(field(value, "error", "context"))
  )
}

function isChangedContext(value: unknown): boolean {
  if (!isExactRecord(value, ["path", "before", "after", "error"])) return false
  const after = field(value, "after", "context"),
    error = field(value, "error", "context")
  return (
    typeof field(value, "path", "context") === "string" &&
    isFileIdentity(field(value, "before", "context")) &&
    (after === null || isFileIdentity(after)) &&
    (error === null || isFileError(error))
  )
}

function isDecodeContext(value: unknown): boolean {
  return hasStringFields(value, ["path", "reason"])
}

function isEpochContext(value: unknown): boolean {
  return (
    isExactRecord(value, ["keyEpoch", "decodedEpoch"]) &&
    isCount(field(value, "keyEpoch", "context")) &&
    isCount(field(value, "decodedEpoch", "context"))
  )
}

function isStorageErrorContext(value: unknown): boolean {
  return (
    isExactRecord(value, ["storageDir", "error"]) &&
    typeof field(value, "storageDir", "context") === "string" &&
    isFileError(field(value, "error", "context"))
  )
}

function isFileError(value: unknown): boolean {
  if (!isExactRecord(value, ["name", "code", "message", "operation"]))
    return false
  const code = field(value, "code", "error"),
    operation = field(value, "operation", "error")
  return (
    typeof field(value, "name", "error") === "string" &&
    (code === null || typeof code === "string") &&
    typeof field(value, "message", "error") === "string" &&
    isFileOperation(operation)
  )
}

function isFileOperation(
  value: unknown
): value is OppEnvelopeTelemetryFileOperation {
  return typeof value === "string" && Object.hasOwn(FileOperationByName, value)
}

function isFileIdentity(value: unknown): boolean {
  return hasStringFields(value, [
    "dev",
    "ino",
    "mode",
    "nlink",
    "size",
    "mtimeNs",
    "ctimeNs"
  ])
}

function hasStringFields(value: unknown, keys: readonly string[]): boolean {
  return (
    isExactRecord(value, keys) &&
    keys.every(key => typeof field(value, key, "context") === "string")
  )
}
