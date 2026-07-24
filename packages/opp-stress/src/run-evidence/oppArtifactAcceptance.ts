import { createHash } from "node:crypto"

import {
  decodeCanonicalMessage,
  validateEnvelopeStorageKey
} from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"

import type {
  RunEvidenceArtifact,
  RunEvidenceDecimal
} from "./RunEvidenceCoreTypes.js"
import {
  RunEvidencePersistenceError,
  RunEvidencePersistenceErrorCode
} from "./RunEvidencePersistenceError.js"

/** Stable validated source bytes and names for one canonical OPP artifact pair. */
export type ValidatedOppArtifact = {
  readonly baseKey: string
  readonly dataBytes: Buffer
  readonly metadataBytes: Buffer
  readonly dataSha256: string
  readonly metadataSha256: string
  readonly batchOpNames: readonly string[]
}

/** Accepted state transition for one validated artifact observation. */
export type ArtifactAcceptance =
  | { readonly kind: "new" }
  | { readonly kind: "stale" }
  | {
      readonly kind: "advance"
      readonly entry: RunEvidenceArtifact
    }

/** Validate exact OPP envelope semantics, digest, metadata, and operator names. */
export function validateOppArtifact(
  baseKey: string,
  dataBytes: Buffer,
  metadataBytes: Buffer
): ValidatedOppArtifact {
  const key = validateEnvelopeStorageKey(baseKey)
  if (key.kind !== "valid")
    throw invalid(`invalid canonical OPP key: ${baseKey}`)
  const dataSha256 = sha256(dataBytes)
  if (dataSha256.slice(0, 16) !== key.value.checksum)
    throw invalid(`data checksum does not match OPP key: ${baseKey}`)

  let envelope: ReturnType<typeof Envelope.fromBinary>
  try {
    envelope = decodeCanonicalMessage(Envelope, dataBytes)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    throw invalid(`data is malformed for OPP key: ${baseKey}`, error)
  }
  if (envelope.epochIndex !== key.value.epochIndex)
    throw invalid(`data epoch does not match OPP key: ${baseKey}`)

  let decoded: ReturnType<typeof DebugEnvelopeMetadataRecord.fromBinary>
  try {
    decoded = decodeCanonicalMessage(DebugEnvelopeMetadataRecord, metadataBytes)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    throw invalid(`metadata is malformed for OPP key: ${baseKey}`, error)
  }
  if (decoded.checksum !== BigInt(`0x${key.value.checksum.slice(0, 12)}`))
    throw invalid(`metadata checksum does not match OPP key: ${baseKey}`)
  if (
    decoded.batchOpNames.length === 0 ||
    decoded.batchOpNames.some(name => name.length === 0) ||
    new Set(decoded.batchOpNames).size !== decoded.batchOpNames.length
  )
    throw invalid(
      `metadata operator names are malformed for OPP key: ${baseKey}`
    )

  return {
    baseKey,
    dataBytes,
    metadataBytes,
    dataSha256,
    metadataSha256: sha256(metadataBytes),
    batchOpNames: [...decoded.batchOpNames].sort()
  }
}

/** Decide append-only or stale-subset acceptance against committed manifest state. */
export function decideArtifactAcceptance(
  existing: RunEvidenceArtifact | null,
  observationOrdinal: RunEvidenceDecimal,
  artifact: ValidatedOppArtifact
): ArtifactAcceptance {
  if (existing === null) return { kind: "new" }
  if (artifact.dataSha256 !== existing.firstImmutableRefs.data.sha256)
    throw conflict(`data changed for committed OPP key: ${artifact.baseKey}`)
  const observation = BigInt(observationOrdinal),
    lastAccepted = BigInt(existing.lastAcceptedObservationOrdinal)
  if (observation <= lastAccepted) {
    if (!isSubset(artifact.batchOpNames, existing.lastAcceptedBatchOpNames))
      throw conflict(
        `stale metadata is not an accepted subset: ${artifact.baseKey}`
      )
    return { kind: "stale" }
  }
  if (!isSubset(existing.lastAcceptedBatchOpNames, artifact.batchOpNames))
    throw conflict(
      `newer metadata removed an accepted operator: ${artifact.baseKey}`
    )
  return {
    kind: "advance",
    entry: {
      ...existing,
      lastAcceptedObservationOrdinal: observationOrdinal,
      lastAcceptedBatchOpNames: artifact.batchOpNames
    }
  }
}

/** Compute a full lowercase SHA-256 digest over exact source or committed bytes. */
export function evidenceSha256(bytes: Uint8Array): string {
  return sha256(bytes)
}

function isSubset(
  subset: readonly string[],
  superset: readonly string[]
): boolean {
  return subset.every(name => superset.includes(name))
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function invalid(
  message: string,
  cause?: unknown
): RunEvidencePersistenceError {
  return new RunEvidencePersistenceError(
    RunEvidencePersistenceErrorCode.InvalidArtifact,
    message,
    cause === undefined ? undefined : { cause }
  )
}

function conflict(message: string): RunEvidencePersistenceError {
  return new RunEvidencePersistenceError(
    RunEvidencePersistenceErrorCode.ArtifactConflict,
    message
  )
}
