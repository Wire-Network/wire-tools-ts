import Path from "node:path"
import type { Stats } from "node:fs"
import type { FileHandle } from "node:fs/promises"

import type { AtomicFile } from "@wireio/debugging-shared"

import { canonicalEvidenceJson } from "./run-evidence/canonicalEvidenceJson.js"
import type {
  RunEvidenceArtifactFile,
  RunEvidenceDecimal,
  RunEvidenceImmutableArtifactRefs,
  RunEvidenceIterationRecordRef,
  RunEvidenceProvenance,
  RunEvidenceRampConfig,
  RunEvidenceSetupRecordRef,
  RunEvidenceTerminalRecordRef
} from "./run-evidence/RunEvidenceCoreTypes.js"
import type {
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle
} from "./run-evidence/runEvidenceConstants.js"
import type {
  RunEvidenceIteration,
  RunEvidenceTerminal
} from "./run-evidence/RunEvidenceRecordTypes.js"
import { allocateRunEvidenceStore } from "./run-evidence/runEvidenceAllocation.js"
import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./run-evidence/RunEvidencePersistenceError.js"
import type { RunEvidencePersistenceStore } from "./run-evidence/RunEvidencePersistenceStore.js"

/** Public facade for one isolated, atomic schema-v1 run-evidence directory. */
export class RunEvidencePersistence {
  /** Canonical lowercase UUID-v4 run identity. */
  readonly runId: string
  /** Absolute fixed directory containing this run's evidence. */
  readonly runDirectory: string
  /** Absolute normalized cluster source root pinned during allocation. */
  readonly clusterPath: string

  private constructor(private readonly store: RunEvidencePersistenceStore) {
    this.runId = Path.basename(store.runDirectory)
    this.runDirectory = store.runDirectory
    this.clusterPath = store.clusterPath
  }

  /**
   * Allocate a run and durably publish its parser-valid initializing manifest.
   * @param options Canonical cluster path and controller-owned run inputs.
   * @param dependencies Optional deterministic Node and AtomicFile seams.
   * @return Ready persistence facade whose manifest exists before setup begins.
   */
  static async allocate(
    options: RunEvidencePersistence.AllocationOptions,
    dependencies: RunEvidencePersistence.Dependencies = {}
  ): Promise<RunEvidencePersistence> {
    return new RunEvidencePersistence(
      await allocateRunEvidenceStore(options, dependencies)
    )
  }

  /** @return Immutable exact-byte cluster-config snapshot reference. */
  captureClusterConfig(): Promise<RunEvidenceArtifactFile> {
    return this.store.captureClusterConfig()
  }

  /**
   * @param record Unknown setup boundary value parsed before publication.
   * @return Immutable setup record reference.
   */
  publishSetup(record: unknown): Promise<RunEvidenceSetupRecordRef> {
    return this.store.publishSetup(record)
  }

  /**
   * @param record Unknown iteration boundary value parsed before publication.
   * @return Immutable contiguous iteration record reference.
   */
  publishIteration(record: unknown): Promise<RunEvidenceIterationRecordRef> {
    return this.store.publishIteration(record)
  }

  /**
   * @param record Unknown terminal boundary value parsed before publication.
   * @return Immutable terminal record reference.
   */
  publishTerminal(record: unknown): Promise<RunEvidenceTerminalRecordRef> {
    return this.store.publishTerminal(record)
  }

  /** Finalize a running setup after an infrastructure exit, exactly once. */
  finalizeInfrastructureFailure(
    input: RunEvidencePersistence.InfrastructureFailureInput
  ): Promise<RunEvidencePersistence.InfrastructureFailureResult> {
    return this.store.finalizeInfrastructureFailure(input)
  }

  /**
   * Assign the next ordinal synchronously before collection begins.
   * @param updatedAtMs Controller timestamp used only when acceptance advances.
   * @return Observation-scoped artifact capture API.
   */
  beginObservation(
    updatedAtMs: RunEvidenceDecimal
  ): RunEvidencePersistence.Observation {
    return this.store.beginObservation(updatedAtMs)
  }

  /** @return Frozen allocation authority for a fresh successfully set up ramp. */
  requireActiveRampContext(): RunEvidencePersistence.ActiveRampContext {
    return this.store.requireActiveRampContext()
  }
}

/** Public option, dependency, and observation contracts for the persistence facade. */
export namespace RunEvidencePersistence {
  /** Exact normal-exit failure retained by canonical infrastructure finalization. */
  export type InfrastructureFailureInput = {
    readonly endedAtMs: RunEvidenceDecimal
    readonly reason: string
    readonly cause: unknown
  }

  /** Canonically committed infrastructure failure and its exact source cause. */
  export type TerminalizedInfrastructureFailure = {
    readonly kind: "terminalized"
    readonly lifecycle: RunEvidenceLifecycle.Failed
    readonly preserveCluster: true
    readonly breakageCategory: RampBreakageCategory.Infrastructure
    readonly breakageReason: string
    readonly cause: unknown
    readonly iteration: RunEvidenceIteration
    readonly terminal: RunEvidenceTerminal
    readonly terminalRef: RunEvidenceTerminalRecordRef
  }

  /** Explicit state when atomic publication cannot truthfully continue. */
  export type FailClosedResult = {
    readonly kind: "fail_closed"
    readonly lifecycle: RunEvidenceLifecycle
    readonly preserveCluster: true
    readonly cause: unknown
  }

  /** Terminalized or explicitly closed result of infrastructure finalization. */
  export type InfrastructureFailureResult =
    TerminalizedInfrastructureFailure | FailClosedResult

  /** Caller-owned immutable inputs for one allocated evidence run. */
  export interface AllocationOptions {
    readonly clusterPath: string
    readonly rampConfig: RunEvidenceRampConfig
    readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
    readonly provenance: RunEvidenceProvenance
    readonly startedAtMs: RunEvidenceDecimal
  }

  /** Narrow immutable allocation authority consumed by the ramp controller. */
  export type ActiveRampContext = {
    /** Run-allocation timestamp used as terminal lifecycle start. */
    readonly startedAtMs: RunEvidenceDecimal
    /** Allocation-owned ramp configuration. */
    readonly rampConfig: RunEvidenceRampConfig
    /** Allocation-owned canonical endpoint order. */
    readonly requiredEndpoints: readonly RunEvidenceEndpoint[]
  }

  /** Runtime identity captured in every allocated manifest. */
  export interface Runtime {
    readonly nodeVersion: string
    readonly platform: string
    readonly architecture: string
  }

  /** Stable source stat fields required to detect path and in-read mutation. */
  export type SourceStat = Pick<
    Stats,
    | "dev"
    | "ino"
    | "size"
    | "mtimeMs"
    | "ctimeMs"
    | "isFile"
    | "isDirectory"
    | "isSymbolicLink"
  >

  /** Stable source handle operations required by safe exact-byte capture. */
  export interface SourceFileHandle {
    readonly readFile: () => Promise<Buffer>
    readonly stat: () => Promise<SourceStat>
    readonly close: () => Promise<void>
  }

  /** Injectable source filesystem used for deterministic mutation and path tests. */
  export interface SourceFileSystem {
    readonly lstat: (file: string) => Promise<SourceStat>
    readonly realpath: (file: string) => Promise<string>
    readonly open: (
      file: string,
      flags: number | "r"
    ) => Promise<SourceFileHandle | FileHandle>
    readonly mkdir: (
      directory: string,
      options: { readonly recursive?: boolean; readonly mode?: number }
    ) => Promise<void>
  }

  /** Deterministic seams; production defaults use Node crypto/fs and AtomicFile. */
  export interface Dependencies {
    readonly randomUUID?: () => string
    readonly runtime?: Runtime
    readonly sourceFileSystem?: Partial<SourceFileSystem>
    readonly atomicFileDependencies?: AtomicFile.Dependencies
  }

  /** Exact strict-reader snapshot selected for one artifact capture. */
  export interface ArtifactCapture {
    readonly baseKey: string
    readonly dataBytes: Buffer
    readonly metadataBytes: Buffer
  }

  /** Ordinal-scoped capture API allocated before source collection begins. */
  export interface Observation {
    readonly ordinal: RunEvidenceDecimal
    readonly captureArtifact: (
      request: ArtifactCapture
    ) => Promise<RunEvidenceImmutableArtifactRefs>
  }
}

export {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./run-evidence/RunEvidencePersistenceError.js"

/**
 * Serialize digest-bearing evidence JSON with the publisher's exact byte policy.
 * @param value JSON-compatible value; bigint values become decimal strings.
 * @return Compact recursive-lexical UTF-8 JSON followed by one newline.
 */
export function serializeRunEvidenceJson(value: unknown): Buffer {
  return canonicalEvidenceJson(value)
}
