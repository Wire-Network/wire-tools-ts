import * as Path from "node:path"
import * as Fs from "node:fs"
import { createHash } from "node:crypto"
import { NestedError } from "@wireio/shared"

import {
  PutEnvelopeResponse,
  ListEnvelopesResponse,
  EnvelopeListEntry,
  DebugOutpostEndpointsType,
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"

import {
  ApiPaths,
  endpointsTypeToKey,
  readEnvelopeRecordsFromDir,
  type LoadEnvelopeRecordsRequest,
  type LoadEnvelopeRecordsResponse
} from "@wireio/debugging-shared"

import { JsonRPC } from "../../JsonRPC.js"

import type express from "express"
import { asOption } from "@3fv/prelude-ts"

// ---------------------------------------------------------------------------
//  Storage-key geometry
// ---------------------------------------------------------------------------

/**
 * Number of hex characters retained from the sha256 checksum when forming the
 * envelope filename. A shorter value makes filenames readable; widening it
 * lowers the chance of accidental collision at the cost of longer keys.
 * The same truncation is used for the `checksum` field echoed back in
 * `EnvelopeListEntry` — keep the two in lockstep.
 */
const ChecksumHexChars = 16

/**
 * Number of checksum hex chars fed into the BigInt metadata field. Must stay
 * ≤ 15 to fit in a `uint64` after the `0x` prefix — the protobuf field is
 * `uint64`, so widening this will produce serialization failures.
 */
const MetadataChecksumHexChars = 12

/** Zero-pad width applied to `epoch_index` when forming storage keys. */
const EpochIndexPadWidth = 8

/** Extensions used by the on-disk envelope storage layout. */
namespace StorageFile {
  export const Data = ".data" as const
  export const Metadata = ".metadata" as const
}

// ---------------------------------------------------------------------------
//  JSON-RPC route registration
// ---------------------------------------------------------------------------

export namespace OPPRoutes {
  /**
   * Register the three OPP JSON-RPC handlers (`Envelope`, `EnvelopeList`,
   * `EnvelopeGet`) on the given {@link JsonRPC.HandlerRegistry}.
   *
   * @param registry       - Mutable registry to populate.
   * @param oppStoragePath - Directory where envelope `.data`/`.metadata`
   *                         files are persisted.
   * @returns The same `registry` instance for fluent chaining.
   */
  export function register(
    registry: JsonRPC.HandlerRegistry,
    oppStoragePath: string
  ): JsonRPC.HandlerRegistry {
    JsonRPC.addRoute(
      registry,
      ApiPaths.OPP.Methods.Envelope,
      async (reqMessage, req: express.Request) => {
        const { envelopeData } = req.body.params as any
        const { batchOpName, endpointsType } = reqMessage

        // 1. protobuf `bytes` fields serialize as base64 in JSON encoding
        const envelopeBytes = Buffer.from(
          envelopeData as unknown as string,
          "base64"
        )

        // 2. Data checksum (sha256 of the raw envelope bytes, truncated)
        const checksum = createHash("sha256")
          .update(envelopeBytes)
          .digest("hex")
          .substring(0, ChecksumHexChars)

        // 3. Parse epoch index from the envelope for the filename prefix
        const envelope = Envelope.fromBinary(envelopeBytes)
        const epochIndex = String(envelope.epochIndex).padStart(
          EpochIndexPadWidth,
          "0"
        )

        // 4. Compose the canonical storage key
        const endpointsKey = endpointsTypeToKey(endpointsType)
        const baseKey = `${epochIndex}-${endpointsKey}-${checksum}`
        const dataFile = Path.join(
          oppStoragePath,
          `${baseKey}${StorageFile.Data}`
        )
        const metadataFile = Path.join(
          oppStoragePath,
          `${baseKey}${StorageFile.Metadata}`
        )

        // 5. Atomic data-file write (skip-if-exists for dedup)
        let dataExisted = false
        try {
          await Fs.promises.writeFile(dataFile, envelopeBytes, { flag: "wx" })
        } catch (err: any) {
          if (err.code === "EEXIST") {
            dataExisted = true
          } else {
            throw err
          }
        }

        // 6. Create or merge metadata (batch-op names accumulate per envelope)
        const metadata = await readOrInitMetadata(
          metadataFile,
          checksum,
          batchOpName
        )
        await Fs.promises.writeFile(
          metadataFile,
          DebugEnvelopeMetadataRecord.toBinary(metadata)
        )

        return PutEnvelopeResponse.create({
          key: baseKey,
          dataExisted,
          batchOpNames: metadata.batchOpNames
        })
      }
    )

    // -----------------------------------------------------------------
    //  LIST — query stored envelopes with optional filters
    // -----------------------------------------------------------------
    JsonRPC.addRoute(
      registry,
      ApiPaths.OPP.Methods.EnvelopeList,
      async params => {
        const {
          epochStart = 0,
          epochEnd = 0,
          endpointsType = DebugOutpostEndpointsType.UNKNOWN,
          timestampStart = 0,
          timestampEnd = 0
        } = params

        const allFiles = await Fs.promises.readdir(oppStoragePath)
        const dataFiles = allFiles
          .filter(f => f.endsWith(StorageFile.Data))
          .sort()

        const resolved = await Promise.all(
          dataFiles.map(dataFile =>
            resolveListEntry(
              dataFile,
              oppStoragePath,
              parsed => {
                if (!parsed) return false
                if (epochStart > 0 && parsed.epochIndex < epochStart)
                  return false
                if (epochEnd > 0 && parsed.epochIndex > epochEnd) return false
                if (endpointsType !== DebugOutpostEndpointsType.UNKNOWN) {
                  const filterKey = endpointsTypeToKey(endpointsType)
                  if (filterKey && parsed.endpointsKey !== filterKey)
                    return false
                }
                return true
              },
              timestampStart,
              timestampEnd
            )
          )
        )
        const entries = resolved.filter(
          (e): e is EnvelopeListEntry => e !== null
        )

        return ListEnvelopesResponse.create({
          entries,
          total: entries.length
        })
      }
    )

    // -----------------------------------------------------------------
    //  LOAD RECORDS — bulk-decoded epoch records for the "load older"
    //  affordance in client UIs. Plain JSON body (no protobuf entry in
    //  HandlerTypeMappings) — dispatcher's else-branch carries it.
    // -----------------------------------------------------------------
    JsonRPC.addRoute(
      registry,
      ApiPaths.OPP.Methods.LoadRecords,
      async (
        params: LoadEnvelopeRecordsRequest
      ): Promise<LoadEnvelopeRecordsResponse> => {
        const records = await readEnvelopeRecordsFromDir(oppStoragePath, {
          epochStart: params.epochStart,
          epochEnd: params.epochEnd,
          endpointsType: params.endpointsType
        })
        return { records }
      }
    )

    // -----------------------------------------------------------------
    //  GET — retrieve a specific stored envelope by key
    // -----------------------------------------------------------------
    JsonRPC.addRoute(
      registry,
      ApiPaths.OPP.Methods.EnvelopeGet,
      async params => {
        const { key } = params

        const dataPath = Path.join(oppStoragePath, `${key}${StorageFile.Data}`)
        const metadataPath = Path.join(
          oppStoragePath,
          `${key}${StorageFile.Metadata}`
        )

        let envelopeData: Uint8Array
        try {
          envelopeData = await Fs.promises.readFile(dataPath)
        } catch (err: any) {
          if (err.code === "ENOENT") {
            throw new NestedError(`Envelope not found: ${key}`, { cause: err })
          }
          throw err
        }

        const { batchOpNames, checksum } =
          await readMetadataSummary(metadataPath)

        const parsed = parseStorageKey(key)
        const stat = await Fs.promises.stat(dataPath)

        return {
          key,
          epochIndex: parsed?.epochIndex ?? 0,
          endpointsType: parsed
            ? resolveEndpointsType(parsed.endpointsKey)
            : DebugOutpostEndpointsType.UNKNOWN,
          checksum,
          batchOpNames,
          timestamp: BigInt(Math.floor(stat.mtimeMs)),
          dataSize: envelopeData.length,
          envelopeData: Buffer.from(envelopeData)
        }
      }
    )

    return registry
  }
}

// ---------------------------------------------------------------------------
//  Storage-key parsing utilities
// ---------------------------------------------------------------------------

/** Decomposed form of a canonical envelope storage key. */
interface ParsedStorageKey {
  /** The original, fully-formed key (round-trips back to the filename). */
  key: string
  /** Numeric epoch index extracted from the zero-padded prefix. */
  epochIndex: number
  /** Endpoints enum variant name as stored in the filename. */
  endpointsKey: string
  /** Truncated sha256 checksum suffix. */
  checksum: string
}

/**
 * Parse a storage key of the form `"<epochIndex>-<endpointsKey>-<checksum>"`.
 *
 * @param key - Filename-style storage key without its extension.
 * @returns The parsed components, or `null` if the key is malformed.
 *
 * @example parseStorageKey("00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890")
 */
function parseStorageKey(key: string): ParsedStorageKey | null {
  const firstDash = key.indexOf("-")
  if (firstDash < 0) return null
  const lastDash = key.lastIndexOf("-")
  if (lastDash <= firstDash) return null

  const epochStr = key.substring(0, firstDash)
  const endpointsKey = key.substring(firstDash + 1, lastDash)
  const checksum = key.substring(lastDash + 1)

  const epochIndex = parseInt(epochStr, 10)
  if (isNaN(epochIndex)) return null

  return { key, epochIndex, endpointsKey, checksum }
}

/**
 * Reverse-map an endpoints enum name back to its numeric value. Falls back
 * to `UNKNOWN` if no matching member exists — e.g. a client on an older
 * protobuf schema wrote a name we no longer recognize.
 */
function resolveEndpointsType(endpointsKey: string): DebugOutpostEndpointsType {
  const raw = (DebugOutpostEndpointsType as Record<string, unknown>)[
    endpointsKey
  ]
  return asOption(raw)
    .filter((v): v is number => typeof v === "number")
    .map(v => v as DebugOutpostEndpointsType)
    .getOrElse(DebugOutpostEndpointsType.UNKNOWN)
}

/**
 * Resolve a single `.data` filename into a populated `EnvelopeListEntry`,
 * or `null` if the key is malformed or fails the filter predicate.
 */
async function resolveListEntry(
  dataFile: string,
  oppStoragePath: string,
  filterParsed: (parsed: ParsedStorageKey | null) => boolean,
  timestampStart: number | bigint,
  timestampEnd: number | bigint
): Promise<EnvelopeListEntry | null> {
  const parsed = parseStorageKey(dataFile.replace(StorageFile.Data, ""))
  if (!filterParsed(parsed) || !parsed) return null

  const dataPath = Path.join(oppStoragePath, dataFile)
  const metadataPath = Path.join(
    oppStoragePath,
    dataFile.replace(StorageFile.Data, StorageFile.Metadata)
  )
  const stat = await Fs.promises.stat(dataPath)
  const timestampMs = stat.mtimeMs

  if (Number(timestampStart) > 0 && timestampMs < Number(timestampStart))
    return null
  if (Number(timestampEnd) > 0 && timestampMs > Number(timestampEnd))
    return null

  const batchOpNames = await readMetadataBatchOpNames(metadataPath)
  return EnvelopeListEntry.create({
    key: parsed.key,
    epochIndex: parsed.epochIndex,
    endpointsType: resolveEndpointsType(parsed.endpointsKey),
    checksum: parsed.checksum,
    batchOpNames,
    timestamp: BigInt(Math.floor(timestampMs)),
    dataSize: stat.size
  })
}

// ---------------------------------------------------------------------------
//  Metadata file helpers
// ---------------------------------------------------------------------------

/**
 * Load an existing metadata record and append `batchOpName` if missing;
 * otherwise initialize a fresh record with a BigInt-packed checksum.
 */
async function readOrInitMetadata(
  metadataFile: string,
  checksum: string,
  batchOpName: string
): Promise<{ checksum: bigint; batchOpNames: string[] }> {
  try {
    const existingBytes = await Fs.promises.readFile(metadataFile)
    const decoded = DebugEnvelopeMetadataRecord.fromBinary(existingBytes)
    const batchOpNames = [...decoded.batchOpNames]
    if (!batchOpNames.includes(batchOpName)) batchOpNames.push(batchOpName)
    return { checksum: decoded.checksum, batchOpNames }
  } catch {
    return {
      checksum: BigInt(`0x${checksum.substring(0, MetadataChecksumHexChars)}`),
      batchOpNames: [batchOpName]
    }
  }
}

/** Read the `batchOpNames` list, tolerating missing metadata files. */
async function readMetadataBatchOpNames(
  metadataPath: string
): Promise<string[]> {
  try {
    const metaBytes = await Fs.promises.readFile(metadataPath)
    return [...DebugEnvelopeMetadataRecord.fromBinary(metaBytes).batchOpNames]
  } catch {
    return []
  }
}

/** Read both batchOp names and checksum in one pass. */
async function readMetadataSummary(
  metadataPath: string
): Promise<{ batchOpNames: string[]; checksum: string }> {
  try {
    const metaBytes = await Fs.promises.readFile(metadataPath)
    const meta = DebugEnvelopeMetadataRecord.fromBinary(metaBytes)
    return {
      batchOpNames: [...meta.batchOpNames],
      checksum: meta.checksum.toString(16)
    }
  } catch {
    return { batchOpNames: [], checksum: "" }
  }
}
