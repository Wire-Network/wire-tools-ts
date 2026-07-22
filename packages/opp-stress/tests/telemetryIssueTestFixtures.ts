import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityFileError,
  type EnvelopeIntegrityFileIdentity,
  type EnvelopeIntegrityIssue
} from "@wireio/debugging-shared"

const CandidateBaseKey = "00000007-OUTPOST_ETHEREUM_DEPOT-0123456789abcdef",
  StorageBaseKey = "$storage",
  SidecarPath = `/tmp/opp-debugging/${CandidateBaseKey}.data`,
  StorageDir = "/tmp/opp-debugging",
  FileError: EnvelopeIntegrityFileError = {
    name: "Error",
    code: "EIO",
    message: "input/output failure",
    operation: "read"
  },
  FileIdentity: EnvelopeIntegrityFileIdentity = {
    dev: "1",
    ino: "2",
    mode: "33188",
    nlink: "1",
    size: "64",
    mtimeNs: "3",
    ctimeNs: "4"
  }

/** Strict issue fixtures covering every integrity code exactly once. */
export const IntegrityIssueFixtures: readonly EnvelopeIntegrityIssue[] = [
  {
    code: EnvelopeIntegrityIssueCode.InvalidStorageKey,
    baseKey: "",
    context: { filename: "", reason: "noncanonical_format" }
  },
  {
    code: EnvelopeIntegrityIssueCode.UnknownEndpoint,
    baseKey: CandidateBaseKey,
    context: { endpointKey: "OUTPOST_UNKNOWN_DEPOT" }
  },
  pathIssue(EnvelopeIntegrityIssueCode.MissingDataSidecar),
  pathIssue(EnvelopeIntegrityIssueCode.MissingMetadataSidecar),
  readIssue(EnvelopeIntegrityIssueCode.DataSidecarSymlink),
  readIssue(EnvelopeIntegrityIssueCode.MetadataSidecarSymlink),
  pathIssue(EnvelopeIntegrityIssueCode.DataSidecarNotRegular),
  pathIssue(EnvelopeIntegrityIssueCode.MetadataSidecarNotRegular),
  readIssue(EnvelopeIntegrityIssueCode.DataReadFailed),
  readIssue(EnvelopeIntegrityIssueCode.MetadataReadFailed),
  changedIssue(EnvelopeIntegrityIssueCode.DataSidecarChanged),
  changedIssue(EnvelopeIntegrityIssueCode.MetadataSidecarChanged),
  decodeIssue(EnvelopeIntegrityIssueCode.DataDecodeFailed),
  decodeIssue(EnvelopeIntegrityIssueCode.MetadataDecodeFailed),
  {
    code: EnvelopeIntegrityIssueCode.DataHashMismatch,
    baseKey: CandidateBaseKey,
    context: {
      expectedHashPrefix: "0123456789abcdef",
      actualHashPrefix: "fedcba9876543210",
      actualSha256: "f".repeat(64)
    }
  },
  {
    code: EnvelopeIntegrityIssueCode.MetadataChecksumMismatch,
    baseKey: CandidateBaseKey,
    context: {
      expectedChecksum: "0123456789ab",
      actualChecksum: "000000000123"
    }
  },
  {
    code: EnvelopeIntegrityIssueCode.EpochMismatch,
    baseKey: CandidateBaseKey,
    context: { keyEpoch: 7, decodedEpoch: 8 }
  },
  {
    code: EnvelopeIntegrityIssueCode.PathOutsideStorageRoot,
    baseKey: CandidateBaseKey,
    context: { storageRoot: StorageDir, path: "/tmp/escape.data" }
  },
  globalPathIssue(EnvelopeIntegrityIssueCode.StorageRootSymlink),
  globalPathIssue(EnvelopeIntegrityIssueCode.StorageAncestorSymlink),
  globalPathIssue(EnvelopeIntegrityIssueCode.StorageRootNotDirectory),
  {
    code: EnvelopeIntegrityIssueCode.StorageRootChanged,
    baseKey: StorageBaseKey,
    context: {
      path: StorageDir,
      before: FileIdentity,
      after: null,
      error: null
    }
  },
  {
    code: EnvelopeIntegrityIssueCode.StorageRootReadFailed,
    baseKey: StorageBaseKey,
    context: { path: StorageDir, error: FileError }
  },
  storageIssue(EnvelopeIntegrityIssueCode.BaselineCaptureFailed),
  storageIssue(EnvelopeIntegrityIssueCode.DirectoryScanFailed)
]

/** Strict issue codes whose scope is the storage root rather than a candidate. */
export const GlobalIntegrityIssueCodes = [
  EnvelopeIntegrityIssueCode.StorageRootSymlink,
  EnvelopeIntegrityIssueCode.StorageAncestorSymlink,
  EnvelopeIntegrityIssueCode.StorageRootNotDirectory,
  EnvelopeIntegrityIssueCode.StorageRootChanged,
  EnvelopeIntegrityIssueCode.StorageRootReadFailed,
  EnvelopeIntegrityIssueCode.BaselineCaptureFailed,
  EnvelopeIntegrityIssueCode.DirectoryScanFailed
] as const

function pathIssue(
  code:
    | EnvelopeIntegrityIssueCode.MissingDataSidecar
    | EnvelopeIntegrityIssueCode.MissingMetadataSidecar
    | EnvelopeIntegrityIssueCode.DataSidecarNotRegular
    | EnvelopeIntegrityIssueCode.MetadataSidecarNotRegular
): EnvelopeIntegrityIssue {
  return { code, baseKey: CandidateBaseKey, context: { path: SidecarPath } }
}

function readIssue(
  code:
    | EnvelopeIntegrityIssueCode.DataSidecarSymlink
    | EnvelopeIntegrityIssueCode.MetadataSidecarSymlink
    | EnvelopeIntegrityIssueCode.DataReadFailed
    | EnvelopeIntegrityIssueCode.MetadataReadFailed
): EnvelopeIntegrityIssue {
  return {
    code,
    baseKey: CandidateBaseKey,
    context: { path: SidecarPath, error: FileError }
  }
}

function changedIssue(
  code:
    | EnvelopeIntegrityIssueCode.DataSidecarChanged
    | EnvelopeIntegrityIssueCode.MetadataSidecarChanged
): EnvelopeIntegrityIssue {
  return {
    code,
    baseKey: CandidateBaseKey,
    context: {
      path: SidecarPath,
      before: FileIdentity,
      after: FileIdentity,
      error: null
    }
  }
}

function decodeIssue(
  code:
    | EnvelopeIntegrityIssueCode.DataDecodeFailed
    | EnvelopeIntegrityIssueCode.MetadataDecodeFailed
): EnvelopeIntegrityIssue {
  return {
    code,
    baseKey: CandidateBaseKey,
    context: { path: SidecarPath, reason: "invalid protobuf" }
  }
}

function globalPathIssue(
  code:
    | EnvelopeIntegrityIssueCode.StorageRootSymlink
    | EnvelopeIntegrityIssueCode.StorageAncestorSymlink
    | EnvelopeIntegrityIssueCode.StorageRootNotDirectory
): EnvelopeIntegrityIssue {
  return { code, baseKey: StorageBaseKey, context: { path: StorageDir } }
}

function storageIssue(
  code:
    | EnvelopeIntegrityIssueCode.BaselineCaptureFailed
    | EnvelopeIntegrityIssueCode.DirectoryScanFailed
): EnvelopeIntegrityIssue {
  return {
    code,
    baseKey: StorageBaseKey,
    context: { storageDir: StorageDir, error: FileError }
  }
}
