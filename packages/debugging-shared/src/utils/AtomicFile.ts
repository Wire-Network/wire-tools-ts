import Fs from "node:fs"
import type { FileHandle as NodeFileHandle } from "node:fs/promises"

import { publishAtomicFile } from "./atomicFilePublisher.js"

/**
 * Atomic publication operations for immutable files and replaceable checkpoints.
 *
 * Strict-reader source bytes are untrusted. Publisher destination directories,
 * including the manifest parent, must be process-owned and trusted against
 * concurrent same-UID namespace mutation. The API rejects symlinked paths at
 * its boundary and provides crash-safe consistency, cooperating-writer
 * atomicity, and truthful commit and durability diagnostics. It does not provide
 * cryptographic authenticity against an actor that can rewrite the destination
 * directory or manifest. That threat requires native descriptor-relative
 * operations, signatures, or a storage redesign.
 */
export namespace AtomicFile {
  /** Filesystem stage at which publication failed. */
  export enum Stage {
    Validate = "validate",
    TempOpen = "temp-open",
    TempWrite = "temp-write",
    FileSync = "file-sync",
    TempClose = "temp-close",
    Link = "link",
    Rename = "rename",
    TempUnlink = "temp-unlink",
    DirectoryOpen = "directory-open",
    DirectorySync = "directory-sync",
    DirectoryClose = "directory-close"
  }

  /** File-handle operations required by the publisher and fault injectors. */
  export type FileHandle = Pick<NodeFileHandle, "writeFile" | "sync" | "close">

  /** Injectable filesystem operations used for deterministic failures and races. */
  export interface FileSystem {
    /** Inspect a directory entry without following symbolic links. */
    readonly lstat: (file: string) => Promise<Pick<Fs.Stats, "isSymbolicLink">>
    /** Open a temporary file exclusively or a parent directory read-only. */
    readonly open: (
      file: string,
      flags: "r" | "wx",
      mode?: number
    ) => Promise<FileHandle>
    /** Atomically create a hard link without replacing the destination. */
    readonly link: (tempFile: string, finalFile: string) => Promise<void>
    /** Atomically replace a destination with a prepared temporary file. */
    readonly rename: (tempFile: string, finalFile: string) => Promise<void>
    /** Remove the temporary directory entry after publication. */
    readonly unlink: (file: string) => Promise<void>
  }

  /** Optional collaborators for deterministic fault injection and temp naming. */
  export interface Dependencies {
    /** Filesystem methods to override while retaining defaults for omitted methods. */
    readonly fileSystem?: Partial<FileSystem>
    /** Unique token source used in the same-directory temporary filename. */
    readonly tempToken?: () => string
  }

  /** Payload and destination for one atomic publication. */
  export interface PublishRequest {
    /** Destination path whose parent also owns the temporary file. */
    readonly finalFile: string
    /** Complete bytes or text to publish. */
    readonly data: string | Uint8Array
    /** Temp-file permissions, defaulting to owner-only. */
    readonly mode?: number
  }

  /** Successful publication result. */
  export interface PublishResult {
    /** Confirms that the link or rename commit point completed. */
    readonly committed: true
    /** Authoritative destination containing the complete payload. */
    readonly finalFile: string
  }

  /** Additional failure observed while preserving an initiating operation failure. */
  export interface SecondaryFailure {
    /** Filesystem stage that failed secondarily. */
    readonly stage: Stage
    /** Original secondary filesystem failure. */
    readonly cause: unknown
  }

  /** Construction state for a typed publication failure. */
  export interface Failure {
    /** Filesystem stage that failed. */
    readonly stage: Stage
    /** Authoritative destination associated with the attempt. */
    readonly finalFile: string
    /** Whether the atomic commit point completed. */
    readonly committed: boolean
    /** Temporary path left behind after failed cleanup. */
    readonly residualTempFile: string | null
    /** Original filesystem failure. */
    readonly cause: unknown
    /** Later failures retained without replacing the initiating cause. */
    readonly secondaryFailures?: readonly SecondaryFailure[]
  }

  /** Typed failure preserving commit state and residual diagnostics. */
  export class PublishError extends Error {
    /** Stable diagnostic name. */
    readonly name = "AtomicFilePublishError"
    /** Filesystem stage that failed. */
    readonly stage: Stage
    /** Authoritative destination associated with the attempt. */
    readonly finalFile: string
    /** Whether the atomic commit point completed. */
    readonly committed: boolean
    /** Temporary path left behind after failed cleanup. */
    readonly residualTempFile: string | null
    /** Later failures retained without replacing the initiating cause. */
    readonly secondaryFailures: readonly SecondaryFailure[]

    /** @param failure Structured failure state and original cause. */
    constructor(failure: Failure) {
      super(
        `${failure.stage} failed ${failure.committed ? "after" : "before"} committing ${failure.finalFile}`,
        { cause: failure.cause }
      )
      this.stage = failure.stage
      this.finalFile = failure.finalFile
      this.committed = failure.committed
      this.residualTempFile = failure.residualTempFile
      this.secondaryFailures = [...(failure.secondaryFailures ?? [])]
    }
  }

  /**
   * Publish an immutable file without replacing an existing destination.
   * @param request Complete payload, destination, and optional permissions.
   * @param dependencies Deterministic filesystem and temp-token overrides.
   * @return A committed result, or a typed {@link PublishError} rejection.
   */
  export function create(
    request: PublishRequest,
    dependencies: Dependencies = {}
  ): Promise<PublishResult> {
    return publishAtomicFile({ request, dependencies, createOnly: true })
  }

  /**
   * Atomically replace a checkpoint with a complete new payload.
   * @param request Complete payload, destination, and optional permissions.
   * @param dependencies Deterministic filesystem and temp-token overrides.
   * @return A committed result, or a typed {@link PublishError} rejection.
   */
  export function replace(
    request: PublishRequest,
    dependencies: Dependencies = {}
  ): Promise<PublishResult> {
    return publishAtomicFile({ request, dependencies, createOnly: false })
  }
}
