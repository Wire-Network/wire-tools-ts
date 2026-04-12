import * as Path from "node:path"
import * as Fs from "node:fs"
import { createHash } from "node:crypto"

import { Envelope } from "@wireio/opp-typescript-models"

import {
  ApiPaths,
  PutEnvelopeResponse,
  ListEnvelopesResponse,
  EnvelopeListEntry,
  GetEnvelopeResponse,
  DebugOutpostEndpointsType,
  endpointsTypeToKey,
  DebugEnvelopeMetadataRecord
} from "@wire-e2e-tests/debugging-shared"

import { addRoute } from "../../JsonRPC"
import type { HandlerRegistry } from "../../JsonRPC"

export namespace OPPRoutes {
  export function register(
    registry: HandlerRegistry,
    oppStoragePath: string
  ): void {
    addRoute(registry, ApiPaths.OPP.Envelope, async params => {
      const { batchOpName, endpointsType, envelopeData } = params

      // 1. protobuf bytes fields serialize as base64 in JSON encoding
      const envelopeBytes = Buffer.from(
        envelopeData as unknown as string,
        "base64"
      )

      // 2. Calculate data checksum (sha256 of the raw envelope bytes)
      const checksum = createHash("sha256")
        .update(envelopeBytes)
        .digest("hex")
        .substring(0, 16) // truncate for filename readability

      // 3. Parse the envelope to extract epoch_index for the filename key
      const envelope = Envelope.fromBinary(envelopeBytes)
      const epochIndex = String(envelope.epochIndex).padStart(8, "0")

      // 4. Generate the storage key
      const endpointsKey = endpointsTypeToKey(endpointsType)
      const baseKey = `${epochIndex}-${endpointsKey}-${checksum}`
      const dataFile = Path.join(oppStoragePath, `${baseKey}.data`)
      const metadataFile = Path.join(oppStoragePath, `${baseKey}.metadata`)

      // 5. Atomic data file write (skip if already exists — dedup)
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

      // 6. Create or update metadata file
      let metadata: { checksum: bigint; batchOpNames: string[] }
      try {
        const existingBytes = await Fs.promises.readFile(metadataFile)
        const decoded = DebugEnvelopeMetadataRecord.fromBinary(existingBytes)
        metadata = {
          checksum: decoded.checksum,
          batchOpNames: [...decoded.batchOpNames]
        }
        if (!metadata.batchOpNames.includes(batchOpName)) {
          metadata.batchOpNames.push(batchOpName)
        }
      } catch {
        metadata = {
          checksum: BigInt(`0x${checksum.substring(0, 12)}`),
          batchOpNames: [batchOpName]
        }
      }
      await Fs.promises.writeFile(
        metadataFile,
        DebugEnvelopeMetadataRecord.toBinary({
          checksum: metadata.checksum,
          batchOpNames: metadata.batchOpNames
        })
      )

      // 7. Return PutEnvelopeResponse
      return PutEnvelopeResponse.create({
        key: baseKey,
        dataExisted,
        batchOpNames: metadata.batchOpNames
      })
    })

    // -----------------------------------------------------------------
    //  LIST — query stored envelopes with optional filters
    // -----------------------------------------------------------------
    addRoute(registry, ApiPaths.OPP.EnvelopeList, async params => {
      const {
        epochStart = 0,
        epochEnd = 0,
        endpointsType = DebugOutpostEndpointsType.UNKNOWN,
        timestampStart = 0,
        timestampEnd = 0
      } = params

      const files = await Fs.promises.readdir(oppStoragePath)
      const dataFiles = files.filter(f => f.endsWith(".data")).sort()

      const entries: EnvelopeListEntry[] = []

      for (const dataFile of dataFiles) {
        const parsed = parseStorageKey(dataFile.replace(".data", ""))
        if (!parsed) continue

        // Epoch range filter
        if (epochStart > 0 && parsed.epochIndex < epochStart) continue
        if (epochEnd > 0 && parsed.epochIndex > epochEnd) continue

        // Endpoints type filter
        if (endpointsType !== DebugOutpostEndpointsType.UNKNOWN) {
          const filterKey = endpointsTypeToKey(endpointsType)
          if (filterKey && parsed.endpointsKey !== filterKey) continue
        }

        // Get file stats for timestamp + size
        const dataPath = Path.join(oppStoragePath, dataFile)
        const metadataPath = Path.join(oppStoragePath, dataFile.replace(".data", ".metadata"))
        const stat = await Fs.promises.stat(dataPath)
        const timestampMs = stat.mtimeMs

        // Timestamp range filter
        if (timestampStart > 0 && timestampMs < Number(timestampStart)) continue
        if (timestampEnd > 0 && timestampMs > Number(timestampEnd)) continue

        // Read metadata for batch_op_names
        let batchOpNames: string[] = []
        try {
          const metaBytes = await Fs.promises.readFile(metadataPath)
          const meta = DebugEnvelopeMetadataRecord.fromBinary(metaBytes)
          batchOpNames = [...meta.batchOpNames]
        } catch { /* metadata may not exist yet */ }

        // Resolve endpoints enum from the key string
        const resolvedEndpoints = resolveEndpointsType(parsed.endpointsKey)

        entries.push(EnvelopeListEntry.create({
          key: parsed.key,
          epochIndex: parsed.epochIndex,
          endpointsType: resolvedEndpoints,
          checksum: parsed.checksum,
          batchOpNames,
          timestamp: BigInt(Math.floor(timestampMs)),
          dataSize: stat.size
        }))
      }

      return ListEnvelopesResponse.create({
        entries,
        total: entries.length
      })
    })

    // -----------------------------------------------------------------
    //  GET — retrieve a specific stored envelope by key
    // -----------------------------------------------------------------
    addRoute(registry, ApiPaths.OPP.EnvelopeGet, async params => {
      const { key } = params

      const dataPath = Path.join(oppStoragePath, `${key}.data`)
      const metadataPath = Path.join(oppStoragePath, `${key}.metadata`)

      // Read envelope data
      let envelopeData: Uint8Array
      try {
        envelopeData = await Fs.promises.readFile(dataPath)
      } catch (err: any) {
        if (err.code === "ENOENT") {
          throw new Error(`Envelope not found: ${key}`)
        }
        throw err
      }

      // Read metadata
      let batchOpNames: string[] = []
      let checksum = ""
      try {
        const metaBytes = await Fs.promises.readFile(metadataPath)
        const meta = DebugEnvelopeMetadataRecord.fromBinary(metaBytes)
        batchOpNames = [...meta.batchOpNames]
        checksum = meta.checksum.toString(16)
      } catch { /* metadata may not exist */ }

      const parsed = parseStorageKey(key)
      const stat = await Fs.promises.stat(dataPath)

      return {
        key,
        epochIndex: parsed?.epochIndex ?? 0,
        endpointsType: parsed ? resolveEndpointsType(parsed.endpointsKey) : DebugOutpostEndpointsType.UNKNOWN,
        checksum,
        batchOpNames,
        timestamp: BigInt(Math.floor(stat.mtimeMs)),
        dataSize: envelopeData.length,
        envelopeData: Buffer.from(envelopeData)
      }
    })
  }
}

// ---------------------------------------------------------------------------
//  Storage key parsing utilities
// ---------------------------------------------------------------------------

interface ParsedStorageKey {
  key: string
  epochIndex: number
  endpointsKey: string
  checksum: string
}

/** Parse a storage key like "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def456" */
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

/** Reverse-map an endpoints key string back to the enum value */
function resolveEndpointsType(endpointsKey: string): DebugOutpostEndpointsType {
  const entries = Object.entries(DebugOutpostEndpointsType)
    .filter(([, v]) => typeof v === "number") as [string, number][]

  for (const [name, value] of entries) {
    if (name === endpointsKey) {
      return value as DebugOutpostEndpointsType
    }
  }
  return DebugOutpostEndpointsType.UNKNOWN
}

export default OPPRoutes
