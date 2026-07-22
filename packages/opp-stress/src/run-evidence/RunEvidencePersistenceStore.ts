import Path from "node:path"

import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import { canonicalEvidenceJson } from "./canonicalEvidenceJson.js"
import { activeRampContext } from "./runEvidenceActiveRampContext.js"
import { evidenceSha256 } from "./oppArtifactAcceptance.js"
import {
  RunEvidencePath,
  RunEvidenceSetupStatus
} from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceArtifactFile,
  RunEvidenceClusterConfigSnapshot,
  RunEvidenceDecimal,
  RunEvidenceIterationRecordRef,
  RunEvidenceSetupRecordRef,
  RunEvidenceTerminalRecordRef
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import type {
  RunEvidenceIteration,
  RunEvidenceSetup,
  RunEvidenceTerminal
} from "./RunEvidenceRecordTypes.js"
import { runningManifestAfterIteration } from "./runEvidenceManifestBuilders.js"
import {
  RunEvidenceArtifactPersistence,
  type RunEvidenceArtifactPersistenceContext
} from "./RunEvidenceArtifactPersistence.js"
import { RunEvidenceArtifactRegistry } from "./RunEvidenceArtifactRegistry.js"
import { RunEvidenceInfrastructureFinalizer } from "./RunEvidenceInfrastructureFinalizer.js"
import { RunEvidencePublicationCoordinator } from "./RunEvidencePublicationCoordinator.js"
import { RunEvidenceSetupPersistence } from "./RunEvidenceSetupPersistence.js"
import { publishRunEvidenceTerminal } from "./RunEvidenceTerminalPersistence.js"
import type { ResolvedPersistenceDependencies } from "./runEvidencePersistenceDependencies.js"
import {
  invalidPersistenceState,
  requireCommittedPersistenceSetup,
  requirePersistenceEndpoints,
  requirePersistenceIteration,
  type PersistenceCapturedConfig
} from "./runEvidencePersistenceValidation.js"

/** Immutable construction state for one allocated persistence store. */
export type RunEvidencePersistenceStoreOptions = {
  readonly runDirectory: string
  readonly clusterPath: string
  readonly manifest: RunEvidenceManifest
  readonly dependencies: ResolvedPersistenceDependencies
}

/** Serialized mutable state behind one allocated public persistence facade. */
export class RunEvidencePersistenceStore {
  private manifest: RunEvidenceManifest
  private config: PersistenceCapturedConfig | null = null
  private setup: RunEvidenceSetup | null = null
  private setupRef: RunEvidenceSetupRecordRef | null = null
  private readonly iterationRefs: RunEvidenceIterationRecordRef[] = []
  private readonly iterations: RunEvidenceIteration[] = []
  private terminalRef: RunEvidenceTerminalRecordRef | null = null
  private readonly coordinator: RunEvidencePublicationCoordinator
  private readonly artifactRegistry: RunEvidenceArtifactRegistry
  private readonly artifactPersistence: RunEvidenceArtifactPersistence
  private readonly setupPersistence: RunEvidenceSetupPersistence
  private readonly infrastructureFinalizer: RunEvidenceInfrastructureFinalizer

  /**
   * @param runDirectory Fixed allocated evidence directory.
   * @param clusterPath Canonical cluster source root.
   * @param manifest Durable initial manifest state.
   * @param dependencies Resolved source and AtomicFile seams.
   */
  constructor(options: RunEvidencePersistenceStoreOptions) {
    this.runDirectory = options.runDirectory
    this.clusterPath = options.clusterPath
    this.manifest = options.manifest
    this.coordinator = new RunEvidencePublicationCoordinator(
      options.runDirectory,
      options.dependencies
    )
    this.artifactRegistry = new RunEvidenceArtifactRegistry(
      this.coordinator,
      manifest => {
        this.manifest = manifest
      }
    )
    const artifactContext: RunEvidenceArtifactPersistenceContext = {
      runDirectory: options.runDirectory,
      requireOpen: () => this.coordinator.requireOpen(),
      exclusive: action => this.coordinator.exclusive(action),
      manifest: () => this.manifest,
      artifact: baseKey => this.artifactRegistry.get(baseKey),
      sortedArtifacts: replacement => this.artifactRegistry.sorted(replacement),
      publishImmutable: request => this.coordinator.publishImmutable(request),
      commit: (entry, manifest, immutableCommitted) =>
        this.artifactRegistry.commit(entry, manifest, immutableCommitted),
      failClosed: error => this.coordinator.failClosed(error)
    }
    this.artifactPersistence = new RunEvidenceArtifactPersistence(
      artifactContext
    )
    this.setupPersistence = new RunEvidenceSetupPersistence({
      runDirectory: options.runDirectory,
      clusterPath: options.clusterPath,
      sourceFileSystem: options.dependencies.sourceFileSystem,
      coordinator: this.coordinator,
      manifest: () => this.manifest,
      config: () => this.config,
      setup: () => this.setup,
      commitConfig: config => {
        this.config = config
      },
      commitSetup: (setup, setupRef, manifest) => {
        if (manifest !== null) this.manifest = manifest
        this.setup = setup
        this.setupRef = setupRef
      }
    })
    this.infrastructureFinalizer = new RunEvidenceInfrastructureFinalizer({
      manifest: () => this.manifest,
      iterations: () => this.iterations,
      iterationRefs: () => this.iterationRefs,
      fatalCause: () => this.coordinator.failure(),
      close: cause => this.coordinator.close(cause),
      publishIteration: input => this.publishIteration(input),
      publishTerminal: input => this.publishTerminal(input)
    })
  }

  readonly runDirectory: string
  readonly clusterPath: string

  /** Capture exact cluster-config bytes without exposing a manifest ref early. */
  captureClusterConfig(): Promise<RunEvidenceArtifactFile> {
    return this.setupPersistence.captureClusterConfig()
  }

  /** Publish the standalone setup record and checkpoint successful setup. */
  publishSetup(input: unknown): Promise<RunEvidenceSetupRecordRef> {
    return this.setupPersistence.publishSetup(input)
  }

  /** Publish the next contiguous immutable iteration and manifest checkpoint. */
  publishIteration(input: unknown): Promise<RunEvidenceIterationRecordRef> {
    return this.coordinator.exclusive(async () => {
      this.coordinator.requireOpen()
      const iteration = requirePersistenceIteration(input),
        setup = requireCommittedPersistenceSetup(this.setup)
      if (setup.status !== RunEvidenceSetupStatus.Succeeded || this.terminalRef)
        throw invalidPersistenceState(
          "iteration publication requires an active successful setup"
        )
      if (iteration.iterationIndex !== this.iterationRefs.length)
        throw invalidPersistenceState(
          "iteration index must be the next contiguous index"
        )
      requirePersistenceEndpoints(iteration.requiredEndpoints, this.manifest)
      const path = `${RunEvidencePath.Iterations}/${String(
          iteration.iterationIndex
        ).padStart(6, "0")}.json` as const,
        bytes = canonicalEvidenceJson(iteration),
        ref: RunEvidenceIterationRecordRef = {
          path,
          sha256: evidenceSha256(bytes)
        }
      await this.coordinator.publishImmutable({
        finalFile: Path.join(this.runDirectory, path),
        data: bytes
      })
      const next = runningManifestAfterIteration(this.manifest, iteration, ref)
      await this.coordinator.replaceAfterImmutable(next)
      this.iterationRefs.push(ref)
      this.iterations.push(iteration)
      this.manifest = next
      return ref
    })
  }

  /** Publish terminal.json and the matching terminal lifecycle checkpoint. */
  publishTerminal(input: unknown): Promise<RunEvidenceTerminalRecordRef> {
    return publishRunEvidenceTerminal(
      {
        runDirectory: this.runDirectory,
        coordinator: this.coordinator,
        manifest: () => this.manifest,
        setup: () => this.setup,
        setupRef: () => this.setupRef,
        iterationRefs: () => this.iterationRefs,
        iterations: () => this.iterations,
        terminalRef: () => this.terminalRef,
        config: () => this.config,
        artifacts: () => this.artifactRegistry.sorted(),
        commit: (ref, manifest) => {
          this.terminalRef = ref
          this.manifest = manifest
        }
      },
      input
    )
  }

  /** Finalize running setup as infrastructure failure or expose fail-closed state. */
  finalizeInfrastructureFailure(
    input: RunEvidencePersistence.InfrastructureFailureInput
  ): Promise<RunEvidencePersistence.InfrastructureFailureResult> {
    return this.infrastructureFinalizer.finalize(input)
  }

  /** Allocate an ordinal synchronously before any observation collection starts. */
  beginObservation(
    updatedAtMs: RunEvidenceDecimal
  ): RunEvidencePersistence.Observation {
    return this.artifactPersistence.beginObservation(updatedAtMs)
  }

  /** Require fresh successful setup and return frozen allocation authority. */
  requireActiveRampContext(): RunEvidencePersistence.ActiveRampContext {
    this.coordinator.requireOpen()
    return activeRampContext({
      manifest: this.manifest,
      setup: this.setup,
      idle: this.coordinator.isIdle(),
      terminalCommitted: this.terminalRef !== null,
      iterationRefs: this.iterationRefs
    })
  }
}
