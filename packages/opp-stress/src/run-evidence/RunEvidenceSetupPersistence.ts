import Path from "node:path"

import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import { canonicalEvidenceJson } from "./canonicalEvidenceJson.js"
import { evidenceSha256 } from "./oppArtifactAcceptance.js"
import {
  RunEvidenceClusterConfigState,
  RunEvidencePath,
  RunEvidenceSetupStatus
} from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifactFile,
  RunEvidenceSetupRecordRef
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type { RunEvidenceSetup } from "./RunEvidenceRecordTypes.js"
import { runningManifestAfterSetup } from "./runEvidenceManifestBuilders.js"
import type { RunEvidencePublicationCoordinator } from "./RunEvidencePublicationCoordinator.js"
import {
  invalidPersistenceState,
  requirePersistenceCapturedConfig,
  requirePersistenceConfigAgreement,
  requirePersistenceSetup,
  type PersistenceCapturedConfig
} from "./runEvidencePersistenceValidation.js"
import { readStableSourceFile } from "./safeEvidenceSource.js"

/** Store-owned setup state and publication operations used by this collaborator. */
export type RunEvidenceSetupPersistenceContext = {
  readonly runDirectory: string
  readonly clusterPath: string
  readonly sourceFileSystem: RunEvidencePersistence.SourceFileSystem
  readonly coordinator: RunEvidencePublicationCoordinator
  readonly manifest: () => RunEvidenceManifest
  readonly config: () => PersistenceCapturedConfig | null
  readonly setup: () => RunEvidenceSetup | null
  readonly commitConfig: (config: PersistenceCapturedConfig) => void
  readonly commitSetup: (
    setup: RunEvidenceSetup,
    setupRef: RunEvidenceSetupRecordRef,
    manifest: RunEvidenceManifest | null
  ) => void
}

/** Persists cluster configuration and setup records for one allocated run. */
export class RunEvidenceSetupPersistence {
  /** @param context Serialized setup state and publication operations. */
  constructor(private readonly context: RunEvidenceSetupPersistenceContext) {}

  /** @return Immutable reference to the exact captured cluster-config bytes. */
  captureClusterConfig(): Promise<RunEvidenceArtifactFile> {
    return this.context.coordinator.exclusive(async () => {
      this.context.coordinator.requireOpen()
      if (this.context.config() !== null || this.context.setup() !== null)
        throw invalidPersistenceState(
          "cluster config capture is no longer available"
        )
      const bytes = await readStableSourceFile(
          this.context.clusterPath,
          "cluster-config.json",
          this.context.sourceFileSystem
        ),
        config: PersistenceCapturedConfig = {
          kind: RunEvidenceClusterConfigState.Captured,
          path: RunEvidencePath.ClusterConfigSnapshot,
          sha256: evidenceSha256(bytes)
        }
      await this.context.coordinator.publishImmutable({
        finalFile: Path.join(this.context.runDirectory, config.path),
        data: bytes
      })
      this.context.commitConfig(config)
      return { path: config.path, sha256: config.sha256 }
    })
  }

  /**
   * @param input Unknown setup boundary value parsed before publication.
   * @return Immutable reference to the committed setup record.
   */
  publishSetup(input: unknown): Promise<RunEvidenceSetupRecordRef> {
    return this.context.coordinator.exclusive(async () => {
      this.context.coordinator.requireOpen()
      if (this.context.setup() !== null)
        throw invalidPersistenceState("setup.json is already committed")
      const setup = requirePersistenceSetup(input),
        config = this.context.config()
      requirePersistenceConfigAgreement(setup, config)
      const bytes = canonicalEvidenceJson(setup),
        setupRef: RunEvidenceSetupRecordRef = {
          path: RunEvidencePath.Setup,
          sha256: evidenceSha256(bytes)
        }
      await this.context.coordinator.publishImmutable({
        finalFile: Path.join(this.context.runDirectory, setupRef.path),
        data: bytes
      })
      let next: RunEvidenceManifest | null = null
      if (setup.status === RunEvidenceSetupStatus.Succeeded) {
        next = runningManifestAfterSetup({
          manifest: this.context.manifest(),
          setup,
          setupRef,
          config: requirePersistenceCapturedConfig(config)
        })
        await this.context.coordinator.replaceAfterImmutable(next)
      }
      this.context.commitSetup(setup, setupRef, next)
      return setupRef
    })
  }
}
