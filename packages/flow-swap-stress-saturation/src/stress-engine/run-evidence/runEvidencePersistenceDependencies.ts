import { randomUUID } from "node:crypto"

import type { AtomicFile } from "../../utils/index.js"

import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import { NodeSourceFileSystem } from "./safeEvidenceSource.js"

/** Fully resolved collaborators retained by one allocated persistence instance. */
export interface ResolvedPersistenceDependencies {
  readonly randomUUID: () => string
  readonly runtime: RunEvidencePersistence.Runtime
  readonly sourceFileSystem: RunEvidencePersistence.SourceFileSystem
  readonly atomicFileDependencies: AtomicFile.Dependencies
}

/** Resolve optional public dependency seams to production Node defaults. */
export function resolvePersistenceDependencies(
  dependencies: RunEvidencePersistence.Dependencies
): ResolvedPersistenceDependencies {
  return {
    randomUUID: dependencies.randomUUID ?? randomUUID,
    runtime: dependencies.runtime ?? {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch
    },
    sourceFileSystem: {
      ...NodeSourceFileSystem,
      ...dependencies.sourceFileSystem
    },
    atomicFileDependencies: dependencies.atomicFileDependencies ?? {}
  }
}
