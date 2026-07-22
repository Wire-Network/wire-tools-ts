import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  type DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  AtomicFile,
  endpointsTypeToKey,
  validateEnvelopeStorageKey
} from "@wireio/debugging-shared"

import {
  EnvelopePersistenceIntegrityError,
  EnvelopePersistenceIntegrityErrorKind,
  isAtomicDuplicateCreate,
  mergeEnvelopeMetadata,
  validateExistingEnvelope
} from "./EnvelopePersistenceIntegrity.js"

const EpochIndexPadWidth = 8,
  DataChecksumHexChars = 16,
  MetadataChecksumHexChars = 12,
  DataExtension = ".data",
  MetadataExtension = ".metadata"

type ResolvedDependencies = {
  readonly create: (
    request: AtomicFile.PublishRequest
  ) => Promise<AtomicFile.PublishResult>
  readonly replace: (
    request: AtomicFile.PublishRequest
  ) => Promise<AtomicFile.PublishResult>
  readonly readFile: (file: string) => Promise<Uint8Array>
}

type Transaction = {
  readonly request: EnvelopePersistence.Request
  readonly key: string
  readonly epochIndex: number
  readonly digest: string
  readonly metadataChecksum: bigint
  readonly dataFile: string
  readonly metadataFile: string
}

const keyTails = new Map<string, Promise<void>>()

/**
 * Atomic persistence for one OPP envelope data/metadata pair.
 *
 * Submitted envelope bytes are untrusted and are validated before publication.
 * The OPP storage directory this publisher writes into is a trust precondition:
 * it must be process-owned and trusted against concurrent same-UID namespace
 * mutation, exactly as {@link AtomicFile} requires of its destination
 * directories. Within that precondition this publisher provides crash-safe
 * consistency, a process-local per-key critical section, metadata-last commit
 * semantics, and truthful commit diagnostics. It does not provide cryptographic
 * authenticity against an actor that can rewrite the storage directory; that
 * threat requires native descriptor-relative operations, signatures, or a
 * storage redesign.
 */
export namespace EnvelopePersistence {
  /** Integrity failures detected before metadata can be safely published. */
  export const IntegrityErrorKind = EnvelopePersistenceIntegrityErrorKind

  /** Type of a persisted envelope integrity failure code. */
  export type IntegrityErrorKind = EnvelopePersistenceIntegrityErrorKind

  /** Typed integrity rejection that identifies the failed persisted invariant. */
  export const IntegrityError = EnvelopePersistenceIntegrityError

  /** Type of a rejection carrying the failed invariant and canonical key. */
  export type IntegrityError = EnvelopePersistenceIntegrityError

  /** Complete input for one envelope publication transaction. */
  export interface Request {
    /** Directory that owns both final files and same-directory atomic temps. */
    readonly storageDir: string
    /** Exact generated `Envelope` protobuf bytes to persist immutably. */
    readonly envelopeData: Uint8Array
    /** Batch operator name to merge into metadata in insertion order. */
    readonly batchOpName: string
    /** Known endpoint direction encoded into the canonical storage key. */
    readonly endpointsType: DebugOutpostEndpointsType
  }

  /** Observable result fields consumed by the future PUT route migration. */
  export interface Result {
    /** Canonical base key shared by the `.data` and `.metadata` files. */
    readonly key: string
    /** Whether immutable data already existed and passed strict validation. */
    readonly dataExisted: boolean
    /** Insertion-ordered unique operator names in committed metadata. */
    readonly batchOpNames: readonly string[]
  }

  /** Optional deterministic I/O seams; omitted operations use public `AtomicFile`. */
  export interface Dependencies {
    /** Override immutable atomic creation, primarily for barrier/fault tests. */
    readonly create?: ResolvedDependencies["create"]
    /** Override atomic replacement, primarily for metadata fault tests. */
    readonly replace?: ResolvedDependencies["replace"]
    /** Override reads while retaining strict ENOENT-only absence handling. */
    readonly readFile?: ResolvedDependencies["readFile"]
  }

  /**
   * Persist one envelope under a process-local per-key transaction queue.
   *
   * @param request Envelope bytes, endpoint direction, operator, and storage root.
   * @param dependencies Optional deterministic atomic I/O collaborators.
   * @return Canonical key, immutable-data existence, and committed operator union.
   */
  export function persist(
    request: Request,
    dependencies: Dependencies = {}
  ): Promise<Result> {
    const transaction = prepareTransaction(request),
      resolved = resolveDependencies(dependencies),
      previousTail = keyTails.get(transaction.key) ?? Promise.resolve(),
      result = previousTail.then(() => persistUnlocked(transaction, resolved)),
      currentTail = result.then(
        () => undefined,
        () => undefined
      )
    keyTails.set(transaction.key, currentTail)
    return result.finally(() => {
      if (keyTails.get(transaction.key) === currentTail) {
        keyTails.delete(transaction.key)
      }
    })
  }
}

function prepareTransaction(request: EnvelopePersistence.Request): Transaction {
  const stableRequest = {
      ...request,
      envelopeData: Uint8Array.from(request.envelopeData)
    },
    envelope = Envelope.fromBinary(stableRequest.envelopeData),
    digest = createHash("sha256")
      .update(stableRequest.envelopeData)
      .digest("hex"),
    epochKey = String(envelope.epochIndex).padStart(EpochIndexPadWidth, "0"),
    endpointsKey = endpointsTypeToKey(request.endpointsType),
    key = endpointsKey
      ? `${epochKey}-${endpointsKey}-${digest.slice(0, DataChecksumHexChars)}`
      : ""
  if (validateEnvelopeStorageKey(key).kind !== "valid") {
    throw new EnvelopePersistence.IntegrityError(
      EnvelopePersistence.IntegrityErrorKind.InvalidStorageKey,
      key
    )
  }
  return {
    request: stableRequest,
    key,
    epochIndex: envelope.epochIndex,
    digest,
    metadataChecksum: BigInt(`0x${digest.slice(0, MetadataChecksumHexChars)}`),
    dataFile: Path.join(stableRequest.storageDir, `${key}${DataExtension}`),
    metadataFile: Path.join(
      stableRequest.storageDir,
      `${key}${MetadataExtension}`
    )
  }
}

function resolveDependencies(
  dependencies: EnvelopePersistence.Dependencies
): ResolvedDependencies {
  return {
    create: dependencies.create ?? (request => AtomicFile.create(request)),
    replace: dependencies.replace ?? (request => AtomicFile.replace(request)),
    readFile: dependencies.readFile ?? (file => Fs.promises.readFile(file))
  }
}

async function persistUnlocked(
  transaction: Transaction,
  dependencies: ResolvedDependencies
): Promise<EnvelopePersistence.Result> {
  let dataExisted = false
  try {
    await dependencies.create({
      finalFile: transaction.dataFile,
      data: transaction.request.envelopeData
    })
  } catch (error) {
    if (!isAtomicDuplicateCreate(error)) throw error
    dataExisted = true
    await validateExistingEnvelope({
      key: transaction.key,
      epochIndex: transaction.epochIndex,
      digest: transaction.digest,
      dataFile: transaction.dataFile,
      envelopeData: transaction.request.envelopeData,
      readFile: dependencies.readFile
    })
  }

  const metadata = await mergeEnvelopeMetadata({
    key: transaction.key,
    metadataFile: transaction.metadataFile,
    metadataChecksum: transaction.metadataChecksum,
    batchOpName: transaction.request.batchOpName,
    readFile: dependencies.readFile
  })
  await dependencies.replace({
    finalFile: transaction.metadataFile,
    data: DebugEnvelopeMetadataRecord.toBinary(metadata)
  })
  return {
    key: transaction.key,
    dataExisted,
    batchOpNames: [...metadata.batchOpNames]
  }
}
