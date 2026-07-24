import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  AttestationType,
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  parseRunEvidenceArtifact,
  RunEvidencePath,
  type RunEvidenceArtifact,
  type RunEvidenceEndpoint
} from "@wireio/test-opp-stress"

/** Artifact-pair inputs used by verifier evidence fixtures. */
export type VerifierArtifactInput = {
  readonly endpoint: RunEvidenceEndpoint
  readonly epoch: number
  readonly epochEnvelopeIndex: number
  readonly byteSize: number
  readonly observationOrdinal: string
}

/** Exact fixture artifact entry and its pair refs. */
export type VerifierArtifactFixture = {
  readonly artifact: RunEvidenceArtifact
  readonly refs: readonly [string, string]
  readonly byteSize: number
  readonly epochEnvelopeIndex: number
}

/** Write one exact-size valid generated Envelope and metadata pair. */
export function writeVerifierArtifact(
  runDirectory: string,
  input: VerifierArtifactInput
): VerifierArtifactFixture {
  const dataBytes = exactEnvelopeBytes(input),
    dataSha256 = sha256(dataBytes),
    baseKey = `${String(input.epoch).padStart(8, "0")}-${input.endpoint}-${dataSha256.slice(0, 16)}`,
    dataRef = `${RunEvidencePath.Artifacts}/${baseKey}.data`,
    metadataRef = `${RunEvidencePath.Artifacts}/${baseKey}.metadata`,
    metadataBytes = Buffer.from(
      DebugEnvelopeMetadataRecord.toBinary(
        DebugEnvelopeMetadataRecord.create({
          checksum: BigInt(`0x${dataSha256.slice(0, 12)}`),
          batchOpNames: ["batchop.a"]
        })
      )
    )
  Fs.writeFileSync(Path.join(runDirectory, dataRef), dataBytes)
  Fs.writeFileSync(Path.join(runDirectory, metadataRef), metadataBytes)
  const artifact = parseRunEvidenceArtifact({
    baseKey,
    firstImmutableRefs: {
      data: { path: dataRef, sha256: dataSha256 },
      metadata: { path: metadataRef, sha256: sha256(metadataBytes) }
    },
    firstAcceptedObservationOrdinal: input.observationOrdinal,
    lastAcceptedObservationOrdinal: input.observationOrdinal,
    lastAcceptedBatchOpNames: ["batchop.a"]
  })
  if ("error" in artifact) throw new Error("generated artifact is invalid")
  return {
    artifact: artifact.value,
    refs: [dataRef, metadataRef],
    byteSize: dataBytes.byteLength,
    epochEnvelopeIndex: input.epochEnvelopeIndex
  }
}

/** Return the full lowercase SHA-256 digest of exact fixture bytes. */
export function verifierFixtureSha256(bytes: Uint8Array): string {
  return sha256(bytes)
}

function exactEnvelopeBytes(input: VerifierArtifactInput): Buffer {
  let lower = 0,
    upper = input.byteSize,
    match: Buffer | null = null
  while (lower <= upper) {
    const payloadSize = Math.floor((lower + upper) / 2),
      bytes = encodeEnvelope(input, payloadSize)
    if (bytes.byteLength === input.byteSize) {
      match = bytes
      break
    }
    if (bytes.byteLength < input.byteSize) lower = payloadSize + 1
    else upper = payloadSize - 1
  }
  if (match !== null) return match
  throw new Error(`cannot encode exact envelope size ${input.byteSize}`)
}

function encodeEnvelope(
  input: VerifierArtifactInput,
  payloadSize: number
): Buffer {
  const payload = new Uint8Array(payloadSize)
  payload.fill(1)
  return Buffer.from(
    Envelope.toBinary(
      Envelope.create({
        epochIndex: input.epoch,
        epochEnvelopeIndex: input.epochEnvelopeIndex,
        epochTimestamp: 1_000n,
        envelopeHash: new Uint8Array(32),
        previousEnvelopeHash: new Uint8Array(32),
        messages: [
          {
            payload: {
              version: 0,
              attestations: [
                {
                  type: AttestationType.UNSPECIFIED,
                  dataSize: payload.length,
                  data: payload
                }
              ]
            }
          }
        ]
      })
    )
  )
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
