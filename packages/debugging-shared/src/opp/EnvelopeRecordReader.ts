import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"

import {
  parseEnvelopeStorageKey,
  resolveEndpointsType
} from "./EnvelopeStorageKey.js"
import { plainify } from "./Plainify.js"
import type {
  DebugOPPEnvelopeRecord,
  DebugOPPEpochRecord
} from "./OPPDebugTypes.js"

/** Shared `.data` / `.metadata` extensions used by every consumer of the OPP debug dir. */
export namespace EnvelopeRecordFile {
  export const DataExt = ".data" as const
  export const MetadataExt = ".metadata" as const
}

/** Optional filter applied while reading the storage directory. */
export interface EnvelopeRecordFilter {
  /** Inclusive lower-bound epoch index; `undefined` means no lower bound. */
  epochStart?: number
  /** Inclusive upper-bound epoch index; `undefined` means no upper bound. */
  epochEnd?: number
  /** Restrict to one endpoints variant; `undefined` (or `UNKNOWN`) returns every variant. */
  endpointsType?: DebugOutpostEndpointsType
}

/**
 * Scan the OPP debug storage directory, decode every `.data`/`.metadata`
 * pair that survives the filter, and return them grouped by epoch (sorted
 * ascending). Each pair is decoded once; per-pair failures are swallowed
 * so a single malformed file doesn't stall the whole batch.
 *
 * Used by both the server's unary `LoadRecords` route and the local-disk
 * client's `loadEnvelopeRecords` implementation — same code path so the
 * shape and dedup rules can't drift between transports.
 */
export async function readEnvelopeRecordsFromDir(
  storageDir: string,
  filter: EnvelopeRecordFilter = {}
): Promise<DebugOPPEpochRecord[]> {
  if (!Fs.existsSync(storageDir)) return []
  const filenames = await Fs.promises.readdir(storageDir),
    baseKeys = filenames
      .filter(f => f.endsWith(EnvelopeRecordFile.MetadataExt))
      .map(f =>
        f.slice(0, -EnvelopeRecordFile.MetadataExt.length)
      ),
    byEpoch = new Map<number, DebugOPPEnvelopeRecord[]>()

  await Promise.all(
    baseKeys.map(async baseKey => {
      const record = await tryReadOne(storageDir, baseKey, filter)
      if (!record) return
      const arr = byEpoch.get(record.epoch) ?? []
      arr.push(record.record)
      byEpoch.set(record.epoch, arr)
    })
  )

  return [...byEpoch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([epoch, envelopes]) => ({ epoch, envelopes }))
}

/** Read + decode one `(epoch, record)` pair. Returns `null` when filtered out or unreadable. */
async function tryReadOne(
  storageDir: string,
  baseKey: string,
  filter: EnvelopeRecordFilter
): Promise<{ epoch: number; record: DebugOPPEnvelopeRecord } | null> {
  const parsed = parseEnvelopeStorageKey(baseKey)
  if (!parsed) return null
  if (filter.epochStart !== undefined && parsed.epochIndex < filter.epochStart)
    return null
  if (filter.epochEnd !== undefined && parsed.epochIndex > filter.epochEnd)
    return null
  const endpointsType = resolveEndpointsType(parsed.endpointsKey)
  if (
    filter.endpointsType !== undefined &&
    filter.endpointsType !== DebugOutpostEndpointsType.UNKNOWN &&
    endpointsType !== filter.endpointsType
  ) {
    return null
  }
  const dataPath = Path.join(
      storageDir,
      baseKey + EnvelopeRecordFile.DataExt
    ),
    metaPath = Path.join(
      storageDir,
      baseKey + EnvelopeRecordFile.MetadataExt
    )
  try {
    const [dataBytes, metaBytes] = await Promise.all([
      Fs.promises.readFile(dataPath),
      Fs.promises.readFile(metaPath)
    ])
    return {
      epoch: parsed.epochIndex,
      record: {
        checksum: parsed.checksum,
        endpointsType,
        envelope: plainify(Envelope.fromBinary(dataBytes)),
        metadata: plainify(
          DebugEnvelopeMetadataRecord.fromBinary(metaBytes)
        ),
        receivedAt: Date.now()
      }
    }
  } catch {
    return null
  }
}
