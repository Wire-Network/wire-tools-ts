import type {
  EnvelopeIntegrityFileError,
  EnvelopeIntegrityFileIdentity,
  EnvelopeIntegrityFileOperation
} from "@wireio/debugging-shared"

/** Closed integrity-issue codes emitted by strict OPP envelope readers. */
export enum OppEnvelopeTelemetryIssueCode {
  /** Storage filename does not use the canonical epoch-endpoint-checksum shape. */
  InvalidStorageKey = "invalid_storage_key",
  /** Storage key names an unsupported endpoint direction. */
  UnknownEndpoint = "unknown_endpoint",
  /** Candidate is missing its `.data` sidecar. */
  MissingDataSidecar = "missing_data_sidecar",
  /** Candidate is missing its `.metadata` sidecar. */
  MissingMetadataSidecar = "missing_metadata_sidecar",
  /** Candidate data sidecar is a symbolic link. */
  DataSidecarSymlink = "data_sidecar_symlink",
  /** Candidate metadata sidecar is a symbolic link. */
  MetadataSidecarSymlink = "metadata_sidecar_symlink",
  /** Candidate data sidecar is not a regular file. */
  DataSidecarNotRegular = "data_sidecar_not_regular",
  /** Candidate metadata sidecar is not a regular file. */
  MetadataSidecarNotRegular = "metadata_sidecar_not_regular",
  /** Candidate data sidecar could not be read. */
  DataReadFailed = "data_read_failed",
  /** Candidate metadata sidecar could not be read. */
  MetadataReadFailed = "metadata_read_failed",
  /** Candidate data sidecar changed during validation. */
  DataSidecarChanged = "data_sidecar_changed",
  /** Candidate metadata sidecar changed during validation. */
  MetadataSidecarChanged = "metadata_sidecar_changed",
  /** Candidate data bytes are not a valid envelope. */
  DataDecodeFailed = "data_decode_failed",
  /** Candidate metadata bytes are not valid metadata. */
  MetadataDecodeFailed = "metadata_decode_failed",
  /** Candidate data digest does not match its storage key. */
  DataHashMismatch = "data_hash_mismatch",
  /** Metadata checksum does not match the candidate key checksum. */
  MetadataChecksumMismatch = "metadata_checksum_mismatch",
  /** Decoded envelope epoch does not match the candidate key epoch. */
  EpochMismatch = "epoch_mismatch",
  /** Candidate sidecar path escapes the storage root. */
  PathOutsideStorageRoot = "path_outside_storage_root",
  /** Storage root itself is a symbolic link. */
  StorageRootSymlink = "storage_root_symlink",
  /** Storage root has a symbolic-link ancestor. */
  StorageAncestorSymlink = "storage_ancestor_symlink",
  /** Storage root is not a directory. */
  StorageRootNotDirectory = "storage_root_not_directory",
  /** Pinned storage root changed during collection. */
  StorageRootChanged = "storage_root_changed",
  /** Storage root could not be inspected or closed. */
  StorageRootReadFailed = "storage_root_read_failed",
  /** Pre-phase baseline capture failed before candidate discovery. */
  BaselineCaptureFailed = "baseline_capture_failed",
  /** OPP storage directory could not be scanned. */
  DirectoryScanFailed = "directory_scan_failed"
}

/** Exact strict-reader filesystem operation retained in telemetry. */
export type OppEnvelopeTelemetryFileOperation = EnvelopeIntegrityFileOperation

/** Exact JSON-safe strict-reader filesystem error retained in telemetry. */
export type OppEnvelopeTelemetryFileError = EnvelopeIntegrityFileError

/** Exact JSON-safe strict-reader file identity retained in telemetry. */
export type OppEnvelopeTelemetryFileIdentity = EnvelopeIntegrityFileIdentity

type InvalidStorageKeyContext = {
  readonly filename: string
  readonly reason: "noncanonical_format" | "invalid_epoch" | "invalid_checksum"
}
type UnknownEndpointContext = { readonly endpointKey: string }
type SidecarPathContext = { readonly path: string }
type SidecarReadContext = {
  readonly path: string
  readonly error: OppEnvelopeTelemetryFileError
}
type SidecarChangedContext = {
  readonly path: string
  readonly before: OppEnvelopeTelemetryFileIdentity
  readonly after: OppEnvelopeTelemetryFileIdentity | null
  readonly error: OppEnvelopeTelemetryFileError | null
}
type SidecarDecodeContext = { readonly path: string; readonly reason: string }
type DataHashContext = {
  readonly expectedHashPrefix: string
  readonly actualHashPrefix: string
  readonly actualSha256: string
}
type MetadataChecksumContext = {
  readonly expectedChecksum: string
  readonly actualChecksum: string
}
type EpochContext = { readonly keyEpoch: number; readonly decodedEpoch: number }
type EscapeContext = { readonly storageRoot: string; readonly path: string }
type StorageErrorContext = {
  readonly storageDir: string
  readonly error: OppEnvelopeTelemetryFileError
}

type TelemetryIssueContextByCode = {
  readonly [OppEnvelopeTelemetryIssueCode.InvalidStorageKey]: InvalidStorageKeyContext
  readonly [OppEnvelopeTelemetryIssueCode.UnknownEndpoint]: UnknownEndpointContext
  readonly [OppEnvelopeTelemetryIssueCode.MissingDataSidecar]: SidecarPathContext
  readonly [OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar]: SidecarPathContext
  readonly [OppEnvelopeTelemetryIssueCode.DataSidecarSymlink]: SidecarReadContext
  readonly [OppEnvelopeTelemetryIssueCode.MetadataSidecarSymlink]: SidecarReadContext
  readonly [OppEnvelopeTelemetryIssueCode.DataSidecarNotRegular]: SidecarPathContext
  readonly [OppEnvelopeTelemetryIssueCode.MetadataSidecarNotRegular]: SidecarPathContext
  readonly [OppEnvelopeTelemetryIssueCode.DataReadFailed]: SidecarReadContext
  readonly [OppEnvelopeTelemetryIssueCode.MetadataReadFailed]: SidecarReadContext
  readonly [OppEnvelopeTelemetryIssueCode.DataSidecarChanged]: SidecarChangedContext
  readonly [OppEnvelopeTelemetryIssueCode.MetadataSidecarChanged]: SidecarChangedContext
  readonly [OppEnvelopeTelemetryIssueCode.DataDecodeFailed]: SidecarDecodeContext
  readonly [OppEnvelopeTelemetryIssueCode.MetadataDecodeFailed]: SidecarDecodeContext
  readonly [OppEnvelopeTelemetryIssueCode.DataHashMismatch]: DataHashContext
  readonly [OppEnvelopeTelemetryIssueCode.MetadataChecksumMismatch]: MetadataChecksumContext
  readonly [OppEnvelopeTelemetryIssueCode.EpochMismatch]: EpochContext
  readonly [OppEnvelopeTelemetryIssueCode.PathOutsideStorageRoot]: EscapeContext
  readonly [OppEnvelopeTelemetryIssueCode.StorageRootSymlink]: SidecarPathContext
  readonly [OppEnvelopeTelemetryIssueCode.StorageAncestorSymlink]: SidecarPathContext
  readonly [OppEnvelopeTelemetryIssueCode.StorageRootNotDirectory]: SidecarPathContext
  readonly [OppEnvelopeTelemetryIssueCode.StorageRootChanged]: SidecarChangedContext
  readonly [OppEnvelopeTelemetryIssueCode.StorageRootReadFailed]: SidecarReadContext
  readonly [OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed]: StorageErrorContext
  readonly [OppEnvelopeTelemetryIssueCode.DirectoryScanFailed]: StorageErrorContext
}

/** JSON-safe integrity issue keyed by its candidate base key or `$storage`. */
export type OppEnvelopeTelemetryIssue = {
  readonly [Code in keyof TelemetryIssueContextByCode]: {
    readonly code: Code
    readonly baseKey: string
    readonly context: TelemetryIssueContextByCode[Code]
  }
}[keyof TelemetryIssueContextByCode]
