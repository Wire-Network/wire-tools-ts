import Path from "node:path"

import type { AtomicFile } from "@wireio/debugging-shared"

import { RunEvidencePath } from "./runEvidenceConstants.js"
import type {
  RunEvidenceArtifact,
  RunEvidenceDecimal,
  RunEvidenceImmutableArtifactRefs
} from "./RunEvidenceCoreTypes.js"
import type { ValidatedOppArtifact } from "./oppArtifactAcceptance.js"

type ImmutablePublisher = (
  request: AtomicFile.PublishRequest
) => Promise<AtomicFile.PublishResult>

/** Complete immutable-pair publication request for one first observation. */
export type FirstOppArtifactPublication = {
  readonly runDirectory: string
  readonly observationOrdinal: RunEvidenceDecimal
  readonly artifact: ValidatedOppArtifact
  readonly publishImmutable: ImmutablePublisher
  readonly failClosed: (error: unknown) => never
}

/** Publish the first immutable pair and return its schema-v1 manifest entry. */
export async function publishFirstOppArtifact(
  input: FirstOppArtifactPublication
): Promise<RunEvidenceArtifact> {
  const dataPath = `${RunEvidencePath.Artifacts}/${input.artifact.baseKey}.data`,
    metadataPath = `${RunEvidencePath.Artifacts}/${input.artifact.baseKey}.metadata`
  await input.publishImmutable({
    finalFile: Path.join(input.runDirectory, dataPath),
    data: input.artifact.dataBytes
  })
  try {
    await input.publishImmutable({
      finalFile: Path.join(input.runDirectory, metadataPath),
      data: input.artifact.metadataBytes
    })
  } catch (error) {
    return input.failClosed(error)
  }
  const refs: RunEvidenceImmutableArtifactRefs = {
    data: { path: dataPath, sha256: input.artifact.dataSha256 },
    metadata: { path: metadataPath, sha256: input.artifact.metadataSha256 }
  }
  return {
    baseKey: input.artifact.baseKey,
    firstImmutableRefs: refs,
    firstAcceptedObservationOrdinal: input.observationOrdinal,
    lastAcceptedObservationOrdinal: input.observationOrdinal,
    lastAcceptedBatchOpNames: input.artifact.batchOpNames
  }
}
