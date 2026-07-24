import { createHash } from "node:crypto"

import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"

import { decodeCanonicalMessage } from "./envelopeIntegrityCanonicalDecode.js"
import {
  resolveEndpointsType,
  validateEnvelopeStorageKey
} from "./EnvelopeStorageKey.js"
import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityIssue
} from "./EnvelopeIntegrityReaderTypes.js"
import { EnvelopeRecordFile } from "./EnvelopeRecordReader.js"
import { readStableFile } from "./envelopeIntegrityFileSystem.js"
import {
  decodeIssueResult,
  invalidKeyResult,
  pendingResult,
  resolveCandidateSidecarPath,
  sidecarReadIssue
} from "./envelopeIntegrityIssues.js"
import type {
  EnvelopeCandidateValidationRequest,
  EnvelopeCandidateValidationResult
} from "./envelopeIntegrityValidationTypes.js"

/**
 * Validate one discovered base key and its stable sidecar bytes.
 * @param request Candidate, root, scan, and filesystem state.
 * @returns Valid pair, pending pair, or structured candidate issue.
 */
export async function validateEnvelopeCandidate(
  request: EnvelopeCandidateValidationRequest
): Promise<EnvelopeCandidateValidationResult> {
  const data = resolveCandidateSidecarPath(request, EnvelopeRecordFile.DataExt),
    metadata = resolveCandidateSidecarPath(
      request,
      EnvelopeRecordFile.MetadataExt
    )
  if (data.kind === "issue") return data
  if (metadata.kind === "issue") return metadata
  const validation = validateEnvelopeStorageKey(request.baseKey)
  if (validation.kind === "invalid")
    return invalidKeyResult(request.baseKey, validation.issue)
  if (
    !request.filenames.has(`${request.baseKey}${EnvelopeRecordFile.DataExt}`)
  ) {
    return pendingResult(request.baseKey, "data", data.path)
  }
  if (
    !request.filenames.has(
      `${request.baseKey}${EnvelopeRecordFile.MetadataExt}`
    )
  ) {
    return pendingResult(request.baseKey, "metadata", metadata.path)
  }

  const dataRead = await readStableFile(data.basename, request.root.handle)
  if (dataRead.kind !== "bytes") {
    return sidecarReadIssue(request.baseKey, "data", data.path, dataRead)
  }
  const metadataRead = await readStableFile(
    metadata.basename,
    request.root.handle
  )
  if (metadataRead.kind !== "bytes") {
    return sidecarReadIssue(
      request.baseKey,
      "metadata",
      metadata.path,
      metadataRead
    )
  }

  let envelope: ReturnType<typeof Envelope.create>
  try {
    envelope = decodeCanonicalMessage(Envelope, dataRead.bytes)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return decodeIssueResult(
      request.baseKey,
      EnvelopeIntegrityIssueCode.DataDecodeFailed,
      data.path,
      error
    )
  }
  let decodedMetadata: ReturnType<typeof DebugEnvelopeMetadataRecord.create>
  try {
    decodedMetadata = decodeCanonicalMessage(
      DebugEnvelopeMetadataRecord,
      metadataRead.bytes
    )
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return decodeIssueResult(
      request.baseKey,
      EnvelopeIntegrityIssueCode.MetadataDecodeFailed,
      metadata.path,
      error
    )
  }

  const sha256 = createHash("sha256").update(dataRead.bytes).digest("hex"),
    actualHashPrefix = sha256.slice(0, 16)
  if (actualHashPrefix !== validation.value.checksum) {
    return candidateIssue({
      code: EnvelopeIntegrityIssueCode.DataHashMismatch,
      baseKey: request.baseKey,
      context: {
        expectedHashPrefix: validation.value.checksum,
        actualHashPrefix,
        actualSha256: sha256
      }
    })
  }
  const expectedMetadataChecksum = validation.value.checksum.slice(0, 12),
    actualMetadataChecksum = decodedMetadata.checksum
      .toString(16)
      .padStart(12, "0")
  if (actualMetadataChecksum !== expectedMetadataChecksum) {
    return candidateIssue({
      code: EnvelopeIntegrityIssueCode.MetadataChecksumMismatch,
      baseKey: request.baseKey,
      context: {
        expectedChecksum: expectedMetadataChecksum,
        actualChecksum: actualMetadataChecksum
      }
    })
  }
  if (envelope.epochIndex !== validation.value.epochIndex) {
    return candidateIssue({
      code: EnvelopeIntegrityIssueCode.EpochMismatch,
      baseKey: request.baseKey,
      context: {
        keyEpoch: validation.value.epochIndex,
        decodedEpoch: envelope.epochIndex
      }
    })
  }

  return {
    kind: "valid",
    value: {
      baseKey: request.baseKey,
      epochIndex: validation.value.epochIndex,
      endpointsType: resolveEndpointsType(validation.value.endpointsKey),
      checksum: validation.value.checksum,
      epochEnvelopeIndex: envelope.epochEnvelopeIndex,
      dataBytes: new Uint8Array(dataRead.bytes),
      metadataBytes: new Uint8Array(metadataRead.bytes),
      dataSha256: sha256,
      dataMtimeNs: dataRead.mtimeNs,
      metadataMtimeNs: metadataRead.mtimeNs,
      metadataChecksum: actualMetadataChecksum,
      batchOpNames: [...decodedMetadata.batchOpNames]
    }
  }
}

function candidateIssue(
  value: EnvelopeIntegrityIssue
): Extract<EnvelopeCandidateValidationResult, { readonly kind: "issue" }> {
  return { kind: "issue", issue: value }
}
