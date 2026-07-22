import { createHash } from "node:crypto"

import { decodeCanonicalMessage } from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"

import {
  RunEvidenceEndpoints,
  type RunEvidenceArtifact,
  type RunEvidenceEndpoint,
  type RunEvidenceManifest
} from "../runEvidenceTypes.js"
import {
  RunEvidenceVerificationIssueCode,
  type RunEvidencePublisherClaim
} from "../runEvidenceVerifierTypes.js"
import { readPinnedFile } from "./pinnedFileReader.js"
import type { PinnedRunDirectory } from "./pinnedPathSupport.js"
import { RunEvidenceVerificationContext } from "./verifierIssues.js"

const BaseKeyPattern =
  /^(?<epoch>\d{8})-(?<endpoint>[A-Z_]+)-(?<checksum>[0-9a-f]{16})$/

/** Independently decoded immutable OPP pair used for metric recomputation. */
export type VerifiedEvidenceArtifact = {
  readonly baseKey: string
  readonly dataRef: string
  readonly metadataRef: string
  readonly endpoint: RunEvidenceEndpoint
  readonly epoch: number
  readonly epochEnvelopeIndex: number
  readonly byteSize: number
  readonly batchOpNames: readonly string[]
}

/** Validated artifact map plus explicitly unproved later publisher claims. */
export type VerifiedEvidenceArtifacts = {
  readonly byBaseKey: ReadonlyMap<string, VerifiedEvidenceArtifact>
  readonly byRef: ReadonlyMap<string, VerifiedEvidenceArtifact>
  readonly publisherClaims: readonly RunEvidencePublisherClaim[]
}

/** Read and independently validate every manifest-declared OPP artifact pair. */
export function verifyEvidenceArtifacts(
  root: PinnedRunDirectory,
  manifest: RunEvidenceManifest,
  context: RunEvidenceVerificationContext
): VerifiedEvidenceArtifacts {
  const valid = manifest.artifacts.flatMap(artifact => {
      const verified = verifyArtifact(root, artifact, context)
      return verified === null ? [] : [verified]
    }),
    byBaseKey = new Map(valid.map(artifact => [artifact.baseKey, artifact])),
    byRef = new Map(
      valid.flatMap(artifact => [
        [artifact.dataRef, artifact] as const,
        [artifact.metadataRef, artifact] as const
      ])
    ),
    publisherClaims = manifest.artifacts.map(artifact => ({
      baseKey: artifact.baseKey,
      lastAcceptedObservationOrdinal: artifact.lastAcceptedObservationOrdinal,
      lastAcceptedBatchOpNames: artifact.lastAcceptedBatchOpNames
    }))
  return { byBaseKey, byRef, publisherClaims }
}

function verifyArtifact(
  root: PinnedRunDirectory,
  artifact: RunEvidenceArtifact,
  context: RunEvidenceVerificationContext
): VerifiedEvidenceArtifact | null {
  const parsedKey = parseBaseKey(artifact.baseKey)
  if (parsedKey === null) {
    context.issue(
      RunEvidenceVerificationIssueCode.InvalidArtifactKey,
      artifact.baseKey,
      "base key is not canonical schema-v1 OPP geometry"
    )
    return null
  }
  const dataRef = artifact.firstImmutableRefs.data,
    metadataRef = artifact.firstImmutableRefs.metadata,
    dataBytes = readPinnedFile(root, dataRef.path, context),
    metadataBytes = readPinnedFile(root, metadataRef.path, context)
  if (dataBytes === null || metadataBytes === null) return null
  const dataSha256 = sha256(dataBytes),
    metadataSha256 = sha256(metadataBytes)
  if (dataSha256 !== dataRef.sha256)
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.ArtifactHashMismatch,
      dataRef.path,
      `data digest differs from manifest ref ${dataRef.sha256}`
    )
  if (metadataSha256 !== metadataRef.sha256)
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.ArtifactHashMismatch,
      metadataRef.path,
      `metadata digest differs from manifest ref ${metadataRef.sha256}`
    )
  if (dataSha256.slice(0, 16) !== parsedKey.checksum)
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.DataChecksumMismatch,
      dataRef.path,
      "data SHA-256 prefix differs from the canonical base key"
    )
  const envelope = decodeEnvelope(dataBytes, dataRef.path, context),
    metadata = decodeMetadata(metadataBytes, metadataRef.path, context)
  if (envelope === null || metadata === null) return null
  if (envelope.epochIndex !== parsedKey.epoch)
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.EpochMismatch,
      dataRef.path,
      `decoded epoch ${envelope.epochIndex} differs from key epoch ${parsedKey.epoch}`
    )
  const actualMetadataChecksum = metadata.checksum
    .toString(16)
    .padStart(12, "0")
  if (actualMetadataChecksum !== parsedKey.checksum.slice(0, 12))
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.MetadataChecksumMismatch,
      metadataRef.path,
      "metadata checksum differs from the first 12 key checksum digits"
    )
  if (
    metadata.batchOpNames.length === 0 ||
    metadata.batchOpNames.some(name => name.length === 0) ||
    new Set(metadata.batchOpNames).size !== metadata.batchOpNames.length
  )
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.InvalidOperators,
      metadataRef.path,
      "first immutable metadata operators must be nonempty and unique"
    )
  if (
    metadata.batchOpNames.some(
      name => !artifact.lastAcceptedBatchOpNames.includes(name)
    )
  )
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.PublisherClaimMismatch,
      metadataRef.path,
      "latest publisher operator claim removed a first-immutable operator"
    )
  return {
    baseKey: artifact.baseKey,
    dataRef: dataRef.path,
    metadataRef: metadataRef.path,
    endpoint: parsedKey.endpoint,
    epoch: parsedKey.epoch,
    epochEnvelopeIndex: envelope.epochEnvelopeIndex,
    byteSize: dataBytes.byteLength,
    batchOpNames: metadata.batchOpNames
  }
}

function parseBaseKey(baseKey: string): {
  readonly epoch: number
  readonly endpoint: RunEvidenceEndpoint
  readonly checksum: string
} | null {
  const match = BaseKeyPattern.exec(baseKey),
    epochText = match?.groups?.["epoch"],
    endpointText = match?.groups?.["endpoint"],
    checksum = match?.groups?.["checksum"],
    endpoint = RunEvidenceEndpoints.find(value => value === endpointText)
  return epochText === undefined ||
    checksum === undefined ||
    endpoint === undefined
    ? null
    : { epoch: Number(epochText), endpoint, checksum }
}

function decodeEnvelope(
  bytes: Uint8Array,
  path: string,
  context: RunEvidenceVerificationContext
): ReturnType<typeof Envelope.create> | null {
  try {
    return decodeCanonicalMessage(Envelope, bytes)
  } catch (error) {
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.DataDecodeFailed,
      path,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

function decodeMetadata(
  bytes: Uint8Array,
  path: string,
  context: RunEvidenceVerificationContext
): ReturnType<typeof DebugEnvelopeMetadataRecord.create> | null {
  try {
    return decodeCanonicalMessage(DebugEnvelopeMetadataRecord, bytes)
  } catch (error) {
    artifactIssue(
      context,
      RunEvidenceVerificationIssueCode.MetadataDecodeFailed,
      path,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
}

function artifactIssue(
  context: RunEvidenceVerificationContext,
  code: RunEvidenceVerificationIssueCode,
  path: string,
  detail: string
): void {
  context.issue(code, path, detail)
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
