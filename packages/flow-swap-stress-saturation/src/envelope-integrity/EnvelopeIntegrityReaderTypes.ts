import type { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

/** Fixed candidate-validation bound; changing it changes strict-reader I/O pressure. */
export const EnvelopeIntegrityValidationConcurrency = 16

/** Closed JSON diagnostic codes emitted by strict envelope validation. */
export enum EnvelopeIntegrityIssueCode {
  /** A discovered base key is not canonical. */
  InvalidStorageKey = "invalid_storage_key",
  /** A discovered key names an unsupported endpoint. */
  UnknownEndpoint = "unknown_endpoint",
  /** A canonical candidate has no data sidecar. */
  MissingDataSidecar = "missing_data_sidecar",
  /** A canonical candidate has no metadata sidecar. */
  MissingMetadataSidecar = "missing_metadata_sidecar",
  /** A data sidecar is a symbolic link. */
  DataSidecarSymlink = "data_sidecar_symlink",
  /** A metadata sidecar is a symbolic link. */
  MetadataSidecarSymlink = "metadata_sidecar_symlink",
  /** A data sidecar is not a regular file. */
  DataSidecarNotRegular = "data_sidecar_not_regular",
  /** A metadata sidecar is not a regular file. */
  MetadataSidecarNotRegular = "metadata_sidecar_not_regular",
  /** A data sidecar could not be opened, read, inspected, or closed. */
  DataReadFailed = "data_read_failed",
  /** A metadata sidecar could not be opened, read, inspected, or closed. */
  MetadataReadFailed = "metadata_read_failed",
  /** A data sidecar changed identity or stat state during validation. */
  DataSidecarChanged = "data_sidecar_changed",
  /** A metadata sidecar changed identity or stat state during validation. */
  MetadataSidecarChanged = "metadata_sidecar_changed",
  /** Data bytes do not decode as an Envelope. */
  DataDecodeFailed = "data_decode_failed",
  /** Metadata bytes do not decode as DebugEnvelopeMetadataRecord. */
  MetadataDecodeFailed = "metadata_decode_failed",
  /** The full data SHA-256 does not match the key prefix. */
  DataHashMismatch = "data_hash_mismatch",
  /** The padded metadata checksum does not match the key. */
  MetadataChecksumMismatch = "metadata_checksum_mismatch",
  /** The decoded envelope epoch does not match the key epoch. */
  EpochMismatch = "epoch_mismatch",
  /** A candidate sidecar path escapes the lexical storage root. */
  PathOutsideStorageRoot = "path_outside_storage_root",
  /** The storage root itself is a symbolic link. */
  StorageRootSymlink = "storage_root_symlink",
  /** An ancestor of the storage root is a symbolic link. */
  StorageAncestorSymlink = "storage_ancestor_symlink",
  /** The storage root is not a directory. */
  StorageRootNotDirectory = "storage_root_not_directory",
  /** The pinned storage root changed during collection. */
  StorageRootChanged = "storage_root_changed",
  /** The storage root could not be inspected or closed. */
  StorageRootReadFailed = "storage_root_read_failed",
  /** Baseline directory discovery failed. */
  BaselineCaptureFailed = "baseline_capture_failed",
  /** Collection directory discovery failed. */
  DirectoryScanFailed = "directory_scan_failed"
}

/**
 * Closed filesystem stages a normalized diagnostic can be attributed to.
 * Each value is the serialized `operation` retained by telemetry consumers.
 */
export enum EnvelopeIntegrityFileOperationKind {
  /** Directory listing through a retained root descriptor. */
  readdir = "readdir",
  /** First no-follow open of a candidate sidecar. */
  open = "open",
  /** Descriptor stat taken before the payload read. */
  stat_before_read = "stat_before_read",
  /** Payload read through the retained descriptor. */
  read = "read",
  /** Descriptor stat taken after the payload read. */
  stat_after_read = "stat_after_read",
  /** Verification re-open of the same basename. */
  verify_open = "verify_open",
  /** Verification stat of the re-opened basename. */
  verify_stat = "verify_stat",
  /** Descriptor close of a candidate sidecar. */
  close = "close",
  /** Link-free inspection of one storage-root ancestor. */
  ancestor_lstat = "ancestor_lstat",
  /** Link-free inspection of the storage root itself. */
  root_lstat = "root_lstat",
  /** Physical canonicalization of the storage root. */
  root_realpath = "root_realpath",
  /** No-follow open of the storage root. */
  root_open = "root_open",
  /** Stat of the retained storage-root descriptor. */
  root_stat = "root_stat",
  /** Verification re-open of the storage root. */
  root_verify_open = "root_verify_open",
  /** Verification stat of the storage root. */
  root_verify_stat = "root_verify_stat",
  /** Close of the retained storage-root descriptor. */
  root_close = "root_close"
}

/** Filesystem operation associated with a normalized diagnostic. */
export type EnvelopeIntegrityFileOperation =
  `${EnvelopeIntegrityFileOperationKind}`

/** Closed reasons one discovered base key fails canonical key validation. */
export enum EnvelopeIntegrityInvalidKeyReasonKind {
  /** The key does not use the canonical epoch-endpoint-checksum geometry. */
  noncanonical_format = "noncanonical_format",
  /** The key carries a non-canonical zero-padded epoch prefix. */
  invalid_epoch = "invalid_epoch",
  /** The key carries a non-canonical checksum suffix. */
  invalid_checksum = "invalid_checksum"
}

/** Serialized reason a discovered base key failed canonical validation. */
export type EnvelopeIntegrityInvalidKeyReason =
  `${EnvelopeIntegrityInvalidKeyReasonKind}`

/** Closed sidecar members of one canonical envelope pair. */
export enum EnvelopeSidecarKind {
  /** Serialized envelope bytes. */
  data = "data",
  /** Serialized publication metadata bytes. */
  metadata = "metadata"
}

/** Sidecar member of one canonical envelope pair. */
export type EnvelopeSidecar = `${EnvelopeSidecarKind}`

/** JSON-safe filesystem failure details for telemetry mapping. */
export interface EnvelopeIntegrityFileError {
  readonly name: string
  readonly code: string | null
  readonly message: string
  readonly operation: EnvelopeIntegrityFileOperation
}

/** JSON-safe file identity and drift fields captured around a read. */
export interface EnvelopeIntegrityFileIdentity {
  readonly dev: string
  readonly ino: string
  readonly mode: string
  readonly nlink: string
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

interface InvalidKeyContext {
  readonly filename: string
  readonly reason: EnvelopeIntegrityInvalidKeyReason
}
interface EndpointContext {
  readonly endpointKey: string
}
interface PathContext {
  readonly path: string
}
interface ReadContext {
  readonly path: string
  readonly error: EnvelopeIntegrityFileError
}
interface ChangedContext {
  readonly path: string
  readonly before: EnvelopeIntegrityFileIdentity
  readonly after: EnvelopeIntegrityFileIdentity | null
  readonly error: EnvelopeIntegrityFileError | null
}
interface DecodeContext {
  readonly path: string
  readonly reason: string
}
interface HashContext {
  readonly expectedHashPrefix: string
  readonly actualHashPrefix: string
  readonly actualSha256: string
}
interface ChecksumContext {
  readonly expectedChecksum: string
  readonly actualChecksum: string
}
interface EpochContext {
  readonly keyEpoch: number
  readonly decodedEpoch: number
}
interface EscapeContext {
  readonly storageRoot: string
  readonly path: string
}
interface StorageContext {
  readonly storageDir: string
  readonly error: EnvelopeIntegrityFileError
}

interface IssueContextByCode {
  readonly [EnvelopeIntegrityIssueCode.InvalidStorageKey]: InvalidKeyContext
  readonly [EnvelopeIntegrityIssueCode.UnknownEndpoint]: EndpointContext
  readonly [EnvelopeIntegrityIssueCode.MissingDataSidecar]: PathContext
  readonly [EnvelopeIntegrityIssueCode.MissingMetadataSidecar]: PathContext
  readonly [EnvelopeIntegrityIssueCode.DataSidecarSymlink]: ReadContext
  readonly [EnvelopeIntegrityIssueCode.MetadataSidecarSymlink]: ReadContext
  readonly [EnvelopeIntegrityIssueCode.DataSidecarNotRegular]: PathContext
  readonly [EnvelopeIntegrityIssueCode.MetadataSidecarNotRegular]: PathContext
  readonly [EnvelopeIntegrityIssueCode.DataReadFailed]: ReadContext
  readonly [EnvelopeIntegrityIssueCode.MetadataReadFailed]: ReadContext
  readonly [EnvelopeIntegrityIssueCode.DataSidecarChanged]: ChangedContext
  readonly [EnvelopeIntegrityIssueCode.MetadataSidecarChanged]: ChangedContext
  readonly [EnvelopeIntegrityIssueCode.DataDecodeFailed]: DecodeContext
  readonly [EnvelopeIntegrityIssueCode.MetadataDecodeFailed]: DecodeContext
  readonly [EnvelopeIntegrityIssueCode.DataHashMismatch]: HashContext
  readonly [EnvelopeIntegrityIssueCode.MetadataChecksumMismatch]: ChecksumContext
  readonly [EnvelopeIntegrityIssueCode.EpochMismatch]: EpochContext
  readonly [EnvelopeIntegrityIssueCode.PathOutsideStorageRoot]: EscapeContext
  readonly [EnvelopeIntegrityIssueCode.StorageRootSymlink]: PathContext
  readonly [EnvelopeIntegrityIssueCode.StorageAncestorSymlink]: PathContext
  readonly [EnvelopeIntegrityIssueCode.StorageRootNotDirectory]: PathContext
  readonly [EnvelopeIntegrityIssueCode.StorageRootChanged]: ChangedContext
  readonly [EnvelopeIntegrityIssueCode.StorageRootReadFailed]: ReadContext
  readonly [EnvelopeIntegrityIssueCode.BaselineCaptureFailed]: StorageContext
  readonly [EnvelopeIntegrityIssueCode.DirectoryScanFailed]: StorageContext
}

/** One code-correlated diagnostic and its exact structured context. */
interface EnvelopeIntegrityIssueRecord<Code extends keyof IssueContextByCode> {
  readonly code: Code
  readonly baseKey: string
  readonly context: IssueContextByCode[Code]
}

/** JSON-safe issue keyed by a candidate base key or the storage scope. */
export type EnvelopeIntegrityIssue = {
  readonly [
    Code in keyof IssueContextByCode
  ]: EnvelopeIntegrityIssueRecord<Code>
}[keyof IssueContextByCode]

/** Readonly issue sequence that statically retains at least one diagnostic. */
export type EnvelopeIntegrityIssueSequence = readonly [
  EnvelopeIntegrityIssue,
  ...EnvelopeIntegrityIssue[]
]

/** Content identity of the sorted unique all-sidecar-key baseline. */
export type EnvelopeBaselineIdentity = `sha256:${string}`

/** Captured union of all sidecar base keys visible before a phase. */
export interface EnvelopeBaseline {
  readonly identity: EnvelopeBaselineIdentity
  readonly baseKeys: readonly string[]
}

/** Baseline capture that observed a stable all-key generation. */
interface EnvelopeBaselineCaptured {
  readonly kind: "captured"
  readonly baseline: EnvelopeBaseline
}

/** Baseline capture that failed before producing an all-key generation. */
interface EnvelopeBaselineCaptureFailed {
  readonly kind: "failed"
  readonly issues: EnvelopeIntegrityIssueSequence
}

/** Non-throwing result of pre-phase all-key discovery. */
export type EnvelopeBaselineCaptureResult =
  EnvelopeBaselineCaptured | EnvelopeBaselineCaptureFailed

/** Canonical candidate awaiting one metadata-last publication sidecar. */
export interface PendingEnvelopePair {
  readonly baseKey: string
  readonly missingSidecar: EnvelopeSidecar
}

/** Strictly validated pair with exact source bytes and decoded projections. */
export interface ValidEnvelopePair {
  readonly baseKey: string
  readonly epochIndex: number
  readonly endpointsType: DebugOutpostEndpointsType
  readonly checksum: string
  readonly epochEnvelopeIndex: number
  readonly dataBytes: Uint8Array
  readonly metadataBytes: Uint8Array
  readonly dataSha256: string
  readonly dataMtimeNs: string
  readonly metadataMtimeNs: string
  readonly metadataChecksum: string
  readonly batchOpNames: readonly string[]
}

interface CollectionFields {
  readonly candidates: readonly string[]
  readonly valid: readonly ValidEnvelopePair[]
  readonly pending: readonly PendingEnvelopePair[]
  readonly issues: readonly EnvelopeIntegrityIssue[]
}

/** Collection that completed every candidate validation. */
interface EnvelopeIntegrityCollectedResult extends CollectionFields {
  readonly kind: "collected"
}

/** Collection terminated by a storage-scope failure. */
interface EnvelopeIntegrityScanFailedResult extends CollectionFields {
  readonly kind: "scan_failed"
}

/** Deterministic non-throwing strict collection result. */
export type EnvelopeIntegrityResult =
  EnvelopeIntegrityCollectedResult | EnvelopeIntegrityScanFailedResult

/** BigInt stat fields required to prove stable regular-file identity. */
export interface EnvelopeIntegrityFileStat {
  readonly dev: bigint
  readonly ino: bigint
  readonly mode: bigint
  readonly nlink: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
  /** Whether this descriptor/path stat is a regular file. */
  isFile(): boolean
  /** Whether this descriptor/path stat is a directory. */
  isDirectory(): boolean
  /** Whether this pathname stat is a symbolic link. */
  isSymbolicLink(): boolean
}

/** Descriptor operations required for one no-follow stable read. */
export interface EnvelopeIntegrityFileHandle {
  stat(): Promise<EnvelopeIntegrityFileStat>
  readFile(): Promise<Buffer>
  close(): Promise<void>
}

/** Descriptor-anchored operations authorized by one retained storage root. */
export interface EnvelopeIntegrityDirectoryHandle extends EnvelopeIntegrityFileHandle {
  /** List children through the retained directory descriptor. */
  readdir(): Promise<readonly string[]>
  /** Open one validated basename relative to the retained directory descriptor. */
  openChild(basename: string): Promise<EnvelopeIntegrityFileHandle>
}

/** Injectable no-follow filesystem boundary for deterministic validation tests. */
export interface EnvelopeIntegrityFileSystem {
  /** Inspect one root component without following links. */
  lstat(path: string): Promise<EnvelopeIntegrityFileStat>
  /** Resolve one root to its physical canonical pathname. */
  realpath(path: string): Promise<string>
  /** Open and retain one root directory with no-follow semantics. */
  openDirectory(path: string): Promise<EnvelopeIntegrityDirectoryHandle>
}

/** Optional strict-reader collaborators. */
export interface EnvelopeIntegrityDependencies {
  readonly fileSystem?: EnvelopeIntegrityFileSystem
}
