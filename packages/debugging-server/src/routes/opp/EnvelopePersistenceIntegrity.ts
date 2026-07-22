import { createHash } from "node:crypto"

import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  AtomicFile,
  validateEnvelopeStorageKey
} from "@wireio/debugging-shared"

const MissingFileCode = "ENOENT",
  DuplicateFileCode = "EEXIST"

/** Integrity failures detected before metadata can be safely published. */
export enum EnvelopePersistenceIntegrityErrorKind {
  InvalidStorageKey = "invalid-storage-key",
  ExistingDataMalformed = "existing-data-malformed",
  ExistingEpochMismatch = "existing-epoch-mismatch",
  ExistingHashMismatch = "existing-hash-mismatch",
  ExistingBytesMismatch = "existing-bytes-mismatch",
  MetadataMalformed = "metadata-malformed",
  MetadataChecksumMismatch = "metadata-checksum-mismatch"
}

/** Typed integrity rejection that identifies the failed persisted invariant. */
export class EnvelopePersistenceIntegrityError extends Error {
  /** Stable diagnostic name. */
  readonly name = "EnvelopePersistenceIntegrityError"

  /**
   * @param kind Persisted invariant that failed.
   * @param key Canonical key associated with the attempted transaction.
   * @param cause Original decode failure, or `null` when comparison failed.
   */
  constructor(
    readonly kind: EnvelopePersistenceIntegrityErrorKind,
    readonly key: string,
    cause: unknown = null
  ) {
    super(`envelope persistence integrity check failed: ${kind} (${key})`, {
      cause
    })
  }
}

/** Inputs required to validate immutable data after a duplicate atomic create. */
export interface ExistingEnvelopeValidation {
  readonly key: string
  readonly epochIndex: number
  readonly digest: string
  readonly dataFile: string
  readonly envelopeData: Uint8Array
  readonly readFile: (file: string) => Promise<Uint8Array>
}

/** Inputs required to read, validate, and merge one metadata record. */
export interface MetadataMerge {
  readonly key: string
  readonly metadataFile: string
  readonly metadataChecksum: bigint
  readonly batchOpName: string
  readonly readFile: (file: string) => Promise<Uint8Array>
}

/**
 * Recognize only an uncommitted public create-only EEXIST diagnostic.
 * @param error Rejected atomic create value.
 * @return Whether immutable data already owns the destination.
 */
export function isAtomicDuplicateCreate(error: unknown): boolean {
  return (
    error instanceof AtomicFile.PublishError &&
    !error.committed &&
    error.stage === AtomicFile.Stage.Link &&
    errorCode(error.cause) === DuplicateFileCode
  )
}

/**
 * Validate decoded epoch, full digest, canonical key suffix, and exact bytes.
 * @param input Expected immutable envelope identity and reader.
 * @return Completion after every persisted-data invariant passes.
 */
export async function validateExistingEnvelope(
  input: ExistingEnvelopeValidation
): Promise<void> {
  const existing = await input.readFile(input.dataFile)
  let decoded: Envelope
  try {
    decoded = Envelope.fromBinary(existing)
  } catch (error) {
    throw new EnvelopePersistenceIntegrityError(
      EnvelopePersistenceIntegrityErrorKind.ExistingDataMalformed,
      input.key,
      error
    )
  }
  if (decoded.epochIndex !== input.epochIndex) {
    throw new EnvelopePersistenceIntegrityError(
      EnvelopePersistenceIntegrityErrorKind.ExistingEpochMismatch,
      input.key
    )
  }
  const existingDigest = createHash("sha256").update(existing).digest("hex"),
    parsedKey = validateEnvelopeStorageKey(input.key)
  if (
    existingDigest !== input.digest ||
    parsedKey.kind !== "valid" ||
    parsedKey.value.checksum !==
      existingDigest.slice(0, parsedKey.value.checksum.length)
  ) {
    throw new EnvelopePersistenceIntegrityError(
      EnvelopePersistenceIntegrityErrorKind.ExistingHashMismatch,
      input.key
    )
  }
  if (!Buffer.from(existing).equals(Buffer.from(input.envelopeData))) {
    throw new EnvelopePersistenceIntegrityError(
      EnvelopePersistenceIntegrityErrorKind.ExistingBytesMismatch,
      input.key
    )
  }
}

/**
 * Read ENOENT as absence, otherwise validate checksum before unique-name merge.
 * @param input Expected metadata identity, operator name, and reader.
 * @return Complete metadata ready for atomic replacement.
 */
export async function mergeEnvelopeMetadata(
  input: MetadataMerge
): Promise<DebugEnvelopeMetadataRecord> {
  let existingBytes: Uint8Array
  try {
    existingBytes = await input.readFile(input.metadataFile)
  } catch (error) {
    if (errorCode(error) === MissingFileCode) {
      return DebugEnvelopeMetadataRecord.create({
        checksum: input.metadataChecksum,
        batchOpNames: [input.batchOpName]
      })
    }
    throw error
  }

  let existing: DebugEnvelopeMetadataRecord
  try {
    existing = DebugEnvelopeMetadataRecord.fromBinary(existingBytes)
  } catch (error) {
    throw new EnvelopePersistenceIntegrityError(
      EnvelopePersistenceIntegrityErrorKind.MetadataMalformed,
      input.key,
      error
    )
  }
  if (existing.checksum !== input.metadataChecksum) {
    throw new EnvelopePersistenceIntegrityError(
      EnvelopePersistenceIntegrityErrorKind.MetadataChecksumMismatch,
      input.key
    )
  }
  return DebugEnvelopeMetadataRecord.create({
    checksum: existing.checksum,
    batchOpNames: [...new Set([...existing.batchOpNames, input.batchOpName])]
  })
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null
  }
  const code = Reflect.get(error, "code")
  return typeof code === "string" ? code : null
}
