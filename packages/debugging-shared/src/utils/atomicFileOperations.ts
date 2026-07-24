import Path from "node:path"

import { AtomicFile } from "./AtomicFile.js"

const UnsupportedDirectorySyncCodes = new Set(["EINVAL", "ENOTSUP", "ENOSYS"])

/** Filesystem context shared by one publication attempt. */
export interface AtomicFileContext {
  /** Authoritative destination. */
  readonly finalFile: string
  /** Unique same-directory temporary path. */
  readonly tempFile: string
  /** Resolved filesystem implementation. */
  readonly fileSystem: AtomicFile.FileSystem
}

/** Internal operation failure retaining later close and cleanup diagnostics. */
export class AtomicFileOperationError extends Error {
  /** Filesystem stage that initiated the failure. */
  readonly stage: AtomicFile.Stage
  /** Original filesystem failure. */
  readonly original: unknown
  /** Later failures that did not replace the initiating failure. */
  readonly secondaryFailures: readonly AtomicFile.SecondaryFailure[]

  /**
   * @param stage Filesystem stage that initiated the failure.
   * @param original Original filesystem failure.
   * @param secondaryFailures Later failures retained for diagnostics.
   */
  constructor(
    stage: AtomicFile.Stage,
    original: unknown,
    secondaryFailures: readonly AtomicFile.SecondaryFailure[] = []
  ) {
    super(`atomic file operation failed at ${stage}`, { cause: original })
    this.stage = stage
    this.original = original
    this.secondaryFailures = secondaryFailures
  }

  /**
   * Return the same primary failure with one later failure appended.
   * @param stage Secondary filesystem stage.
   * @param cause Secondary filesystem failure.
   * @return New immutable operation error.
   */
  withSecondary(
    stage: AtomicFile.Stage,
    cause: unknown
  ): AtomicFileOperationError {
    return new AtomicFileOperationError(this.stage, this.original, [
      ...this.secondaryFailures,
      { stage, cause }
    ])
  }

  /**
   * Append another operation failure and its secondary diagnostics.
   * @param operation Later operation failure.
   * @return New immutable operation error.
   */
  withOperation(operation: AtomicFileOperationError): AtomicFileOperationError {
    return new AtomicFileOperationError(this.stage, this.original, [
      ...this.secondaryFailures,
      { stage: operation.stage, cause: operation.original },
      ...operation.secondaryFailures
    ])
  }
}

/**
 * Write and fsync a temporary file while preserving primary and close failures.
 * @param context Publication filesystem context.
 * @param data Complete payload.
 * @param mode Temporary-file permissions.
 */
export async function writeAtomicTemp(
  context: AtomicFileContext,
  data: string | Uint8Array,
  mode: number
): Promise<void> {
  let stage = AtomicFile.Stage.TempOpen,
    handle: AtomicFile.FileHandle | null = null,
    failure: AtomicFileOperationError | null = null
  try {
    handle = await context.fileSystem.open(context.tempFile, "wx", mode)
    stage = AtomicFile.Stage.TempWrite
    await handle.writeFile(data)
    stage = AtomicFile.Stage.FileSync
    await handle.sync()
  } catch (error) {
    failure = new AtomicFileOperationError(stage, error)
  }
  if (handle) {
    try {
      await handle.close()
    } catch (error) {
      failure = failure
        ? failure.withSecondary(AtomicFile.Stage.TempClose, error)
        : new AtomicFileOperationError(AtomicFile.Stage.TempClose, error)
    }
  }
  if (failure) throw failure
}

/**
 * Remove the prepared temp, normalizing absent entries to successful cleanup.
 * @param context Publication filesystem context.
 * @return Null on absence/success, otherwise the cleanup failure.
 */
export async function removeAtomicTemp(
  context: AtomicFileContext
): Promise<unknown | null> {
  try {
    await context.fileSystem.unlink(context.tempFile)
    return null
  } catch (error) {
    return atomicFileErrorCode(error) === "ENOENT" ? null : error
  }
}

/**
 * Sync the parent directory, ignoring unsupported codes only from sync itself.
 * @param context Publication filesystem context.
 */
export async function syncAtomicParent(
  context: AtomicFileContext
): Promise<void> {
  let handle: AtomicFile.FileHandle
  try {
    handle = await context.fileSystem.open(Path.dirname(context.finalFile), "r")
  } catch (error) {
    throw new AtomicFileOperationError(AtomicFile.Stage.DirectoryOpen, error)
  }

  let failure: AtomicFileOperationError | null = null
  try {
    await handle.sync()
  } catch (error) {
    if (
      !UnsupportedDirectorySyncCodes.has(String(atomicFileErrorCode(error)))
    ) {
      failure = new AtomicFileOperationError(
        AtomicFile.Stage.DirectorySync,
        error
      )
    }
  }
  try {
    await handle.close()
  } catch (error) {
    failure = failure
      ? failure.withSecondary(AtomicFile.Stage.DirectoryClose, error)
      : new AtomicFileOperationError(AtomicFile.Stage.DirectoryClose, error)
  }
  if (failure) throw failure
}

/**
 * Extract a string-like errno code without unsafe type assertions.
 * @param error Unknown filesystem failure.
 * @return Error code or null when absent.
 */
export function atomicFileErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : null
}
