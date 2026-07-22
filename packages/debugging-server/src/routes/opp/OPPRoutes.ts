import * as Path from "node:path"
import * as Fs from "node:fs"

import {
  PutEnvelopeResponse,
  ListEnvelopesResponse,
  EnvelopeListEntry,
  GetEnvelopeResponse,
  DebugOutpostEndpointsType,
  DebugEnvelopeMetadataRecord
} from "@wireio/opp-typescript-models"

import {
  ApiPaths,
  endpointsTypeToKey,
  readEnvelopeRecordsFromDir,
  type LoadEnvelopeRecordsRequest,
  type LoadEnvelopeRecordsResponse
} from "@wireio/debugging-shared"

import { JsonRPC } from "../../JsonRPC.js"
import { EnvelopePersistence } from "./EnvelopePersistence.js"

import { asOption } from "@3fv/prelude-ts"

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
      async reqMessage => {
        const result = await EnvelopePersistence.persist({
          storageDir: oppStoragePath,
          envelopeData: reqMessage.envelopeData,
          batchOpName: reqMessage.batchOpName,
          endpointsType: reqMessage.endpointsType
        })
        return PutEnvelopeResponse.create({
          key: result.key,
          dataExisted: result.dataExisted,
          batchOpNames: [...result.batchOpNames]
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
            throw new Error(`Envelope not found: ${key}`)
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
