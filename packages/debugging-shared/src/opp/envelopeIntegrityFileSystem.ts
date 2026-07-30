import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  EnvelopeIntegrityFileOperationKind,
  type EnvelopeIntegrityDirectoryHandle,
  type EnvelopeIntegrityFileError,
  type EnvelopeIntegrityFileHandle,
  type EnvelopeIntegrityFileIdentity,
  type EnvelopeIntegrityFileStat,
  type EnvelopeIntegrityFileSystem
} from "./EnvelopeIntegrityReaderTypes.js"
import { normalizeUnknownError } from "./envelopeIntegrityError.js"
import { fileIdentity, sameIdentity } from "./envelopeIntegrityFileIdentity.js"

/** Stable bytes read through one descriptor that never changed identity. */
interface StableFileBytes {
  readonly kind: "bytes"
  readonly bytes: Buffer
  readonly mtimeNs: string
}

/** Candidate sidecar rejected because the pathname is a symbolic link. */
interface StableFileSymlink {
  readonly kind: "symlink"
  readonly error: EnvelopeIntegrityFileError
}

/** Candidate sidecar rejected because it is not a regular file. */
interface StableFileNotRegular {
  readonly kind: "not_regular"
}

/** Candidate sidecar whose identity or stat state moved during the read. */
interface StableFileChanged {
  readonly kind: "changed"
  readonly before: EnvelopeIntegrityFileIdentity
  readonly after: EnvelopeIntegrityFileIdentity | null
  readonly error: EnvelopeIntegrityFileError | null
}

/** Candidate sidecar whose read failed with a normalized filesystem error. */
interface StableFileFailed {
  readonly kind: "failed"
  readonly error: EnvelopeIntegrityFileError
}

/** Stable descriptor-bound bytes or a structured filesystem outcome. */
export type StableFileReadResult =
  | StableFileBytes
  | StableFileSymlink
  | StableFileNotRegular
  | StableFileChanged
  | StableFileFailed

/** Stable-read outcome that yielded no bytes for the candidate sidecar. */
export type FailedStableFileReadResult =
  | StableFileSymlink
  | StableFileNotRegular
  | StableFileChanged
  | StableFileFailed

/** Descriptor stat that observed a live file identity. */
interface StatFileObserved {
  readonly kind: "stat"
  readonly stat: EnvelopeIntegrityFileStat
}

/** Descriptor stat outcome consumed by one stable read. */
type StatFileResult = StatFileObserved | StableFileFailed

/** Descriptor stat stages of one stable read. */
type StatFileOperation =
  | EnvelopeIntegrityFileOperationKind.stat_before_read
  | EnvelopeIntegrityFileOperationKind.stat_after_read
  | EnvelopeIntegrityFileOperationKind.verify_stat

/** Real Node filesystem adapter with no-follow sidecar opens. */
export const NodeEnvelopeIntegrityFileSystem: EnvelopeIntegrityFileSystem = {
  lstat: path => Fs.promises.lstat(path, { bigint: true }),
  realpath: path => Fs.promises.realpath(path),
  openDirectory: async path => {
    const handle = await Fs.promises.open(
      path,
      Fs.constants.O_RDONLY | Fs.constants.O_DIRECTORY | Fs.constants.O_NOFOLLOW
    )
    return directoryHandle(handle)
  }
}

function directoryHandle(
  handle: Fs.promises.FileHandle
): EnvelopeIntegrityDirectoryHandle {
  const descriptorRoot = `/proc/self/fd/${handle.fd}`
  return {
    stat: () => handle.stat({ bigint: true }),
    readFile: () => handle.readFile(),
    close: () => handle.close(),
    readdir: () => Fs.promises.readdir(descriptorRoot),
    openChild: async basename => {
      if (
        Path.basename(basename) !== basename ||
        basename === "." ||
        basename === ".."
      ) {
        throw new TypeError("Envelope sidecar must be a basename")
      }
      return fileHandle(
        await Fs.promises.open(
          Path.join(descriptorRoot, basename),
          Fs.constants.O_RDONLY | Fs.constants.O_NOFOLLOW
        )
      )
    }
  }
}

function fileHandle(
  handle: Fs.promises.FileHandle
): EnvelopeIntegrityFileHandle {
  return {
    stat: () => handle.stat({ bigint: true }),
    readFile: () => handle.readFile(),
    close: () => handle.close()
  }
}

/**
 * Read one regular sidecar through a stable no-follow descriptor.
 * @param file Absolute sidecar pathname beneath the pinned root.
 * @param fileSystem Typed filesystem seam.
 * @returns Stable bytes or a structured sidecar failure.
 */
export async function readStableFile(
  basename: string,
  root: EnvelopeIntegrityDirectoryHandle
): Promise<StableFileReadResult> {
  let handle: EnvelopeIntegrityFileHandle
  try {
    handle = await root.openChild(basename)
  } catch (error) {
    const normalized = normalizeUnknownError(
      error,
      EnvelopeIntegrityFileOperationKind.open
    )
    return normalized.code === "ELOOP"
      ? { kind: "symlink", error: normalized }
      : { kind: "failed", error: normalized }
  }

  const result = await readOpenedFile(basename, handle, root),
    closeError = await closeFile(handle)
  return closeError === null ? result : { kind: "failed", error: closeError }
}

async function readOpenedFile(
  basename: string,
  handle: EnvelopeIntegrityFileHandle,
  root: EnvelopeIntegrityDirectoryHandle
): Promise<StableFileReadResult> {
  const before = await statFile(
    handle,
    EnvelopeIntegrityFileOperationKind.stat_before_read
  )
  if (before.kind === "failed") return before
  if (!before.stat.isFile()) return { kind: "not_regular" }

  let bytes: Buffer
  try {
    bytes = await handle.readFile()
  } catch (error) {
    return {
      kind: "failed",
      error: normalizeUnknownError(
        error,
        EnvelopeIntegrityFileOperationKind.read
      )
    }
  }

  const after = await statFile(
      handle,
      EnvelopeIntegrityFileOperationKind.stat_after_read
    ),
    beforeIdentity = fileIdentity(before.stat)
  if (after.kind === "failed") return after
  const afterIdentity = fileIdentity(after.stat)
  if (!sameIdentity(beforeIdentity, afterIdentity)) {
    return {
      kind: "changed",
      before: beforeIdentity,
      after: afterIdentity,
      error: null
    }
  }
  return verifyCurrentChild(basename, root, beforeIdentity, bytes)
}

async function verifyCurrentChild(
  basename: string,
  root: EnvelopeIntegrityDirectoryHandle,
  before: EnvelopeIntegrityFileIdentity,
  bytes: Buffer
): Promise<StableFileReadResult> {
  let handle: EnvelopeIntegrityFileHandle
  try {
    handle = await root.openChild(basename)
  } catch (error) {
    return {
      kind: "changed",
      before,
      after: null,
      error: normalizeUnknownError(
        error,
        EnvelopeIntegrityFileOperationKind.verify_open
      )
    }
  }
  const current = await statFile(
      handle,
      EnvelopeIntegrityFileOperationKind.verify_stat
    ),
    closeError = await closeFile(handle)
  if (current.kind === "failed") {
    return { kind: "changed", before, after: null, error: current.error }
  }
  if (closeError !== null) return { kind: "failed", error: closeError }
  const after = fileIdentity(current.stat)
  return current.stat.isFile() && sameIdentity(before, after)
    ? { kind: "bytes", bytes, mtimeNs: before.mtimeNs }
    : { kind: "changed", before, after, error: null }
}

async function statFile(
  handle: EnvelopeIntegrityFileHandle,
  operation: StatFileOperation
): Promise<StatFileResult> {
  try {
    return { kind: "stat", stat: await handle.stat() }
  } catch (error) {
    return { kind: "failed", error: normalizeUnknownError(error, operation) }
  }
}

async function closeFile(
  handle: EnvelopeIntegrityFileHandle
): Promise<EnvelopeIntegrityFileError> {
  try {
    await handle.close()
    return null
  } catch (error) {
    return normalizeUnknownError(
      error,
      EnvelopeIntegrityFileOperationKind.close
    )
  }
}
