import Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"

import { canonicalEvidenceJson } from "./canonicalEvidenceJson.js"
import { RunEvidencePath } from "./runEvidenceConstants.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type { ResolvedPersistenceDependencies } from "./runEvidencePersistenceDependencies.js"

/** Serialized AtomicFile commit coordinator shared by lifecycle and artifact paths. */
export class RunEvidencePublicationCoordinator {
  private operationTail = Promise.resolve()
  private fatalError: unknown | null = null
  private pendingOperationCount = 0

  /**
   * @param runDirectory Fixed allocated run directory.
   * @param dependencies Resolved AtomicFile collaborators.
   */
  constructor(
    private readonly runDirectory: string,
    private readonly dependencies: ResolvedPersistenceDependencies
  ) {}

  /** Run one state transition after all prior transitions release the queue. */
  async exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.operationTail,
      next = Promise.withResolvers<void>()
    this.pendingOperationCount += 1
    this.operationTail = next.promise
    await previous
    try {
      return await action()
    } finally {
      this.pendingOperationCount -= 1
      next.resolve()
    }
  }

  /** Return true only when no publication is active or queued. */
  isIdle(): boolean {
    return this.pendingOperationCount === 0
  }

  /** Publish one immutable file and fail closed after uncertain committed faults. */
  async publishImmutable(
    request: AtomicFile.PublishRequest
  ): Promise<AtomicFile.PublishResult> {
    try {
      return await AtomicFile.create(
        request,
        this.dependencies.atomicFileDependencies
      )
    } catch (error) {
      if (error instanceof AtomicFile.PublishError && error.committed)
        return this.failClosed(error)
      throw error
    }
  }

  async replaceManifest(manifest: RunEvidenceManifest): Promise<void> {
    try {
      await AtomicFile.replace(
        {
          finalFile: Path.join(this.runDirectory, RunEvidencePath.Manifest),
          data: canonicalEvidenceJson(manifest)
        },
        this.dependencies.atomicFileDependencies
      )
    } catch (error) {
      if (error instanceof AtomicFile.PublishError && error.committed)
        return this.failClosed(error)
      throw error
    }
  }

  async replaceAfterImmutable(manifest: RunEvidenceManifest): Promise<void> {
    return this.replaceManifest(manifest).then(
      () => undefined,
      error => this.failClosed(error)
    )
  }

  /** Preserve and rethrow the exact failure that makes later publication unsafe. */
  failClosed(error: unknown): never {
    this.fatalError = error
    throw error
  }

  /** Close publication without throwing when no truthful recovery is available. */
  close(error: unknown): void {
    this.fatalError = error
  }

  /** Return the exact cause that closed publication, or null while still open. */
  failure(): unknown | null {
    return this.fatalError
  }

  /** Throw the original terminal publication failure before any later operation. */
  requireOpen(): void {
    if (this.fatalError !== null) throw this.fatalError
  }
}
