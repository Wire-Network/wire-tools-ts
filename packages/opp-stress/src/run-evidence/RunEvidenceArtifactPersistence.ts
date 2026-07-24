import type { AtomicFile } from "@wireio/debugging-shared"

import type { RunEvidencePersistence } from "../runEvidencePersistence.js"
import {
  decideArtifactAcceptance,
  validateOppArtifact
} from "./oppArtifactAcceptance.js"
import { RunEvidenceLifecycle } from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceDecimal,
  RunEvidenceImmutableArtifactRefs
} from "./RunEvidenceCoreTypes.js"
import type { RunEvidenceManifest } from "./RunEvidenceManifestTypes.js"
import { publishFirstOppArtifact } from "./runEvidenceArtifactPublisher.js"
import { runningManifestWithArtifacts } from "./runEvidenceManifestBuilders.js"
import {
  invalidPersistenceState,
  persistenceDecimal,
  requirePersistenceDecimal
} from "./runEvidencePersistenceValidation.js"

/** Shared state operations required by ordinal-scoped artifact persistence. */
export type RunEvidenceArtifactPersistenceContext = {
  readonly runDirectory: string
  readonly requireOpen: () => void
  readonly exclusive: <T>(action: () => Promise<T>) => Promise<T>
  readonly manifest: () => RunEvidenceManifest
  readonly artifact: (baseKey: string) => RunEvidenceArtifact | null
  readonly sortedArtifacts: (
    replacement: RunEvidenceArtifact
  ) => readonly RunEvidenceArtifact[]
  readonly publishImmutable: (
    request: AtomicFile.PublishRequest
  ) => Promise<AtomicFile.PublishResult>
  readonly commit: (
    entry: RunEvidenceArtifact,
    manifest: RunEvidenceManifest,
    immutableCommitted: boolean
  ) => Promise<void>
  readonly failClosed: (error: unknown) => never
}

/** Observation-ordinal allocation and raw artifact acceptance for one run. */
export class RunEvidenceArtifactPersistence {
  private nextObservationOrdinal = 0n
  private readonly immutableDataBytes = new Map<string, Buffer>()

  /** @param context Serialized shared run state and publication operations. */
  constructor(
    private readonly context: RunEvidenceArtifactPersistenceContext
  ) {}

  /** Allocate an ordinal synchronously before source collection begins. */
  beginObservation(
    updatedAtMs: RunEvidenceDecimal
  ): RunEvidencePersistence.Observation {
    this.context.requireOpen()
    const canonicalUpdatedAtMs = requirePersistenceDecimal(updatedAtMs),
      ordinal = persistenceDecimal(this.nextObservationOrdinal),
      captureArtifact = (request: RunEvidencePersistence.ArtifactCapture) =>
        this.captureArtifact(ordinal, canonicalUpdatedAtMs, request)
    this.nextObservationOrdinal += 1n
    return { ordinal, captureArtifact }
  }

  private async captureArtifact(
    ordinal: RunEvidenceDecimal,
    updatedAtMs: RunEvidenceDecimal,
    request: RunEvidencePersistence.ArtifactCapture
  ): Promise<RunEvidenceImmutableArtifactRefs> {
    const dataBytes = Buffer.from(request.dataBytes),
      metadataBytes = Buffer.from(request.metadataBytes),
      artifact = validateOppArtifact(request.baseKey, dataBytes, metadataBytes)
    return this.context.exclusive(async () => {
      this.context.requireOpen()
      const manifest = this.context.manifest()
      if (manifest.lifecycle !== RunEvidenceLifecycle.Running)
        throw invalidPersistenceState(
          "artifact capture requires a running lifecycle"
        )
      const existing = this.context.artifact(request.baseKey),
        decision = decideArtifactAcceptance(existing, ordinal, artifact)
      if (existing !== null) {
        const firstBytes = this.immutableDataBytes.get(request.baseKey)
        if (firstBytes === undefined || !firstBytes.equals(artifact.dataBytes))
          throw invalidPersistenceState(
            `data bytes changed for committed OPP key: ${request.baseKey}`
          )
      }
      if (decision.kind === "stale") {
        if (existing === null)
          throw invalidPersistenceState("stale artifact has no immutable refs")
        return existing.firstImmutableRefs
      }
      const entry =
          decision.kind === "advance"
            ? decision.entry
            : await publishFirstOppArtifact({
                runDirectory: this.context.runDirectory,
                observationOrdinal: ordinal,
                artifact,
                publishImmutable: this.context.publishImmutable,
                failClosed: this.context.failClosed
              }),
        next = runningManifestWithArtifacts(
          manifest,
          this.context.sortedArtifacts(entry),
          updatedAtMs
        )
      await this.context.commit(entry, next, decision.kind === "new")
      if (decision.kind === "new")
        this.immutableDataBytes.set(
          entry.baseKey,
          Buffer.from(artifact.dataBytes)
        )
      return entry.firstImmutableRefs
    })
  }
}
