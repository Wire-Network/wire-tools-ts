import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityIssue
} from "@wireio/debugging-shared"

import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryIssue
} from "./TelemetryIssueTypes.js"

/**
 * Map one strict-reader issue to its lossless telemetry counterpart.
 *
 * @param issue Strict reader issue with code-correlated context.
 * @returns Telemetry issue preserving the serialized code, base key, and context.
 */
export function mapEnvelopeIntegrityIssue(
  issue: EnvelopeIntegrityIssue
): OppEnvelopeTelemetryIssue {
  switch (issue.code) {
    case EnvelopeIntegrityIssueCode.InvalidStorageKey:
      return {
        code: OppEnvelopeTelemetryIssueCode.InvalidStorageKey,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.UnknownEndpoint:
      return {
        code: OppEnvelopeTelemetryIssueCode.UnknownEndpoint,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MissingDataSidecar:
      return {
        code: OppEnvelopeTelemetryIssueCode.MissingDataSidecar,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MissingMetadataSidecar:
      return {
        code: OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.DataSidecarSymlink:
      return {
        code: OppEnvelopeTelemetryIssueCode.DataSidecarSymlink,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MetadataSidecarSymlink:
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataSidecarSymlink,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.DataSidecarNotRegular:
      return {
        code: OppEnvelopeTelemetryIssueCode.DataSidecarNotRegular,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MetadataSidecarNotRegular:
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataSidecarNotRegular,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.DataReadFailed:
      return {
        code: OppEnvelopeTelemetryIssueCode.DataReadFailed,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MetadataReadFailed:
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataReadFailed,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.DataSidecarChanged:
      return {
        code: OppEnvelopeTelemetryIssueCode.DataSidecarChanged,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MetadataSidecarChanged:
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataSidecarChanged,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.DataDecodeFailed:
      return {
        code: OppEnvelopeTelemetryIssueCode.DataDecodeFailed,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MetadataDecodeFailed:
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataDecodeFailed,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.DataHashMismatch:
      return {
        code: OppEnvelopeTelemetryIssueCode.DataHashMismatch,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.MetadataChecksumMismatch:
      return {
        code: OppEnvelopeTelemetryIssueCode.MetadataChecksumMismatch,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.EpochMismatch:
      return {
        code: OppEnvelopeTelemetryIssueCode.EpochMismatch,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.PathOutsideStorageRoot:
      return {
        code: OppEnvelopeTelemetryIssueCode.PathOutsideStorageRoot,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.StorageRootSymlink:
      return {
        code: OppEnvelopeTelemetryIssueCode.StorageRootSymlink,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.StorageAncestorSymlink:
      return {
        code: OppEnvelopeTelemetryIssueCode.StorageAncestorSymlink,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.StorageRootNotDirectory:
      return {
        code: OppEnvelopeTelemetryIssueCode.StorageRootNotDirectory,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.StorageRootChanged:
      return {
        code: OppEnvelopeTelemetryIssueCode.StorageRootChanged,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.StorageRootReadFailed:
      return {
        code: OppEnvelopeTelemetryIssueCode.StorageRootReadFailed,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.BaselineCaptureFailed:
      return {
        code: OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed,
        baseKey: issue.baseKey,
        context: issue.context
      }
    case EnvelopeIntegrityIssueCode.DirectoryScanFailed:
      return {
        code: OppEnvelopeTelemetryIssueCode.DirectoryScanFailed,
        baseKey: issue.baseKey,
        context: issue.context
      }
    default:
      return assertNever(issue)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected envelope integrity issue: ${String(value)}`)
}
