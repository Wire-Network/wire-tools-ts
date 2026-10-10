import Fs from "node:fs"
import Path from "node:path"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope,
  type AttestationType,
  type AttestationEntry
} from "@wireio/opp-typescript-models"

/** The fixed checksum segment of every fixture artifact key. */
export const FixtureArtifactChecksum = "abcdef0123456789"
/** Digits the epoch segment of an artifact key is zero-padded to. */
export const ArtifactEpochDigits = 8

/**
 * Write one OPP debugging artifact PAIR for `direction` carrying `payload`.
 *
 * Both halves, because the cluster writes both and the scanners consume different ones: the
 * byte-tag scan reads `.data` alone, while `readEnvelopeAttestations` enumerates `.metadata`
 * keys and reads the pair.
 *
 * @param directory - The OPP debugging directory; created when missing.
 * @param direction - The relay direction the artifact key names.
 * @param payload - The serialized envelope bytes written as `.data`.
 * @param epoch - The epoch the artifact key names.
 */
export function writeOppArtifact(
  directory: string,
  direction: DebugOutpostEndpointsType,
  payload: Buffer,
  epoch = 1
): void {
  const baseKey = `${String(epoch).padStart(ArtifactEpochDigits, "0")}-${DebugOutpostEndpointsType[direction]}-${FixtureArtifactChecksum}`
  Fs.mkdirSync(directory, { recursive: true })
  Fs.writeFileSync(Path.join(directory, `${baseKey}.data`), payload)
  Fs.writeFileSync(
    Path.join(directory, `${baseKey}.metadata`),
    Buffer.from(
      DebugEnvelopeMetadataRecord.toBinary({
        checksum: BigInt(payload.length),
        batchOpNames: []
      })
    )
  )
}

/**
 * One `AttestationEntry` with its `dataSize` derived from the payload.
 *
 * @param type - The attestation's wire discriminant.
 * @param data - The serialized attestation payload.
 * @return The entry an envelope message carries.
 */
export function attestationEntry(
  type: AttestationType,
  data: Uint8Array
): AttestationEntry {
  return { type, dataSize: data.length, data }
}

/**
 * A one-message envelope carrying `attestations`, serialized as a `.data` artifact would be.
 *
 * @param attestations - The entries the single message carries.
 * @return The envelope's wire bytes.
 */
export function envelopeBytes(attestations: AttestationEntry[]): Buffer {
  return Buffer.from(
    Envelope.toBinary({
      envelopeHash: new Uint8Array(),
      epochTimestamp: 0n,
      epochIndex: 1,
      epochEnvelopeIndex: 0,
      previousEnvelopeHash: new Uint8Array(),
      messages: [{ header: undefined, payload: { version: 0, attestations } }]
    })
  )
}
