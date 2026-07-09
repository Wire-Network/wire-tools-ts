import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  EnvelopeRecordFile,
  parseEnvelopeStorageKey,
  resolveEndpointsType
} from "@wireio/debugging-shared"

import {
  compareEnvelopeMetrics,
  emptyMetrics,
  formatError,
  malformed
} from "./envelopeMetricsSupport.js"

/** Maximum OPP envelope payload size; changing it changes saturation ratios. */
export const MaxEnvelopeBytes = 65_536

/** Minimum raw OPP envelope bytes treated as near-cap saturation evidence. */
export const SaturatedEnvelopeMinBytes = Math.floor(MaxEnvelopeBytes * 0.95)

/** Solana raw transaction byte cap; changing it changes saturation classification. */
export const SolanaRawTransactionBytesMax = 1_232

/** Inclusive filters for one stress phase's OPP envelope collection window. */
export type EnvelopeSaturationWindow = {
  /** Direction to count; omit or use UNKNOWN to include every direction. */
  readonly endpointsType?: DebugOutpostEndpointsType
  /** Inclusive epoch lower bound. */
  readonly epochStart?: number
  /** Inclusive epoch upper bound. */
  readonly epochEnd?: number
  /** Inclusive data-file mtime lower bound in Unix milliseconds. */
  readonly timestampStartMs?: number
  /** Inclusive data-file mtime upper bound in Unix milliseconds. */
  readonly timestampEndMs?: number
}

/** Decoded envelope metric used to decide whether one phase rolled over. */
export type EnvelopeMetric = {
  /** Storage key without `.data` / `.metadata`. */
  readonly key: string
  /** Source-side epoch index parsed from the storage key. */
  readonly epoch: number
  /** Endpoint direction parsed from the storage key. */
  readonly endpointsType: DebugOutpostEndpointsType
  /** Truncated checksum parsed from the storage key. */
  readonly checksum: string
  /** `Envelope.epochEnvelopeIndex`, used to detect rollover order. */
  readonly epochEnvelopeIndex: number
  /** Raw `.data` byte count. */
  readonly byteSize: number
  /** Raw byte-size saturation ratio against the OPP envelope cap. */
  readonly saturationRatio: number
  /** Batch-operator names recorded in the paired metadata file. */
  readonly batchOpNames: readonly string[]
}

/** Malformed fixture report for skipped envelope pairs. */
export type MalformedEnvelopeRecord = {
  /** Storage key without extension when available, otherwise the malformed base name. */
  readonly key: string
  /** Human-readable reason the pair could not be included. */
  readonly reason: string
}

/** Envelope saturation metrics for one stress phase and direction/window. */
export type EnvelopeSaturationMetrics = {
  /** Whether any matching record is near the OPP envelope byte cap. */
  readonly saturated: boolean
  /** Whether any matching Solana destination envelope exceeds the raw transaction byte cap. */
  readonly solanaOversized: boolean
  /** Number of valid matching envelopes. */
  readonly envelopeCount: number
  /** Matching raw envelope byte sizes in deterministic order. */
  readonly byteSizes: readonly number[]
  /** Matching `epochEnvelopeIndex` values in deterministic order. */
  readonly epochEnvelopeIndexes: readonly number[]
  /** Full per-envelope metric records in deterministic order. */
  readonly envelopes: readonly EnvelopeMetric[]
  /** Malformed pairs skipped during collection. */
  readonly malformedRecords: readonly MalformedEnvelopeRecord[]
}

type ReadMetricResult =
  | { readonly kind: "metric"; readonly metric: EnvelopeMetric }
  | { readonly kind: "malformed"; readonly record: MalformedEnvelopeRecord }
  | { readonly kind: "filtered" }

type TimestampWindowResult =
  | { readonly kind: "matches"; readonly matches: boolean }
  | Extract<ReadMetricResult, { kind: "malformed" }>

/**
 * Collect OPP envelope saturation metrics from a debugging storage directory.
 *
 * @param storageDir Directory containing `.data` / `.metadata` OPP debug pairs.
 * @param window Direction and epoch/time filters for one stress phase.
 * @returns Envelope counts, byte sizes, rollover status, and malformed-pair reports.
 */
export async function collectEnvelopeSaturationMetrics(
  storageDir: string,
  window: EnvelopeSaturationWindow = {}
): Promise<EnvelopeSaturationMetrics> {
  if (!Fs.existsSync(storageDir)) return emptyMetrics()
  const filenames = await Fs.promises.readdir(storageDir),
    baseKeys = filenames
      .filter(filename => filename.endsWith(EnvelopeRecordFile.MetadataExt))
      .map(filename =>
        filename.slice(0, -EnvelopeRecordFile.MetadataExt.length)
      ),
    results = await Promise.all(
      baseKeys.map(baseKey => readMetric(storageDir, baseKey, window))
    ),
    envelopes = results
      .filter(
        (result): result is Extract<ReadMetricResult, { kind: "metric" }> =>
          result.kind === "metric"
      )
      .map(result => result.metric)
      .sort(compareEnvelopeMetrics),
    malformedRecords = results
      .filter(
        (result): result is Extract<ReadMetricResult, { kind: "malformed" }> =>
          result.kind === "malformed"
      )
      .map(result => result.record)

  return {
    saturated: envelopes.some(
      envelope => envelope.byteSize >= SaturatedEnvelopeMinBytes
    ),
    solanaOversized: envelopes.some(
      envelope =>
        envelope.endpointsType ===
          DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA &&
        envelope.byteSize > SolanaRawTransactionBytesMax
    ),
    envelopeCount: envelopes.length,
    byteSizes: envelopes.map(envelope => envelope.byteSize),
    epochEnvelopeIndexes: envelopes.map(
      envelope => envelope.epochEnvelopeIndex
    ),
    envelopes,
    malformedRecords
  }
}

async function readMetric(
  storageDir: string,
  baseKey: string,
  window: EnvelopeSaturationWindow
): Promise<ReadMetricResult> {
  const parsed = parseEnvelopeStorageKey(baseKey)
  if (parsed === null) return malformed(baseKey, "malformed storage key")
  const endpointsType = resolveEndpointsType(parsed.endpointsKey)
  if (!matchesWindow(parsed.epochIndex, endpointsType, window)) {
    return { kind: "filtered" }
  }
  const dataPath = Path.join(storageDir, baseKey + EnvelopeRecordFile.DataExt),
    metadataPath = Path.join(
      storageDir,
      baseKey + EnvelopeRecordFile.MetadataExt
    ),
    readResult = await readBytes(dataPath, metadataPath, baseKey)
  if (readResult.kind === "malformed") return readResult

  const timestampResult = await matchesTimestampWindow(dataPath, window)
  if (timestampResult.kind === "malformed") return timestampResult
  if (!timestampResult.matches) return { kind: "filtered" }

  return decodeMetric(
    baseKey,
    parsed.epochIndex,
    endpointsType,
    parsed.checksum,
    readResult
  )
}

function matchesWindow(
  epoch: number,
  endpointsType: DebugOutpostEndpointsType,
  window: EnvelopeSaturationWindow
): boolean {
  if (window.epochStart !== undefined && epoch < window.epochStart) return false
  if (window.epochEnd !== undefined && epoch > window.epochEnd) return false
  if (
    window.endpointsType !== undefined &&
    window.endpointsType !== DebugOutpostEndpointsType.UNKNOWN &&
    endpointsType !== window.endpointsType
  ) {
    return false
  }
  return true
}

async function matchesTimestampWindow(
  dataPath: string,
  window: EnvelopeSaturationWindow
): Promise<TimestampWindowResult> {
  if (
    window.timestampStartMs === undefined &&
    window.timestampEndMs === undefined
  ) {
    return { kind: "matches", matches: true }
  }
  try {
    const mtimeMs = (await Fs.promises.stat(dataPath)).mtimeMs
    if (
      window.timestampStartMs !== undefined &&
      mtimeMs < window.timestampStartMs
    ) {
      return { kind: "matches", matches: false }
    }
    if (
      window.timestampEndMs !== undefined &&
      mtimeMs > window.timestampEndMs
    ) {
      return { kind: "matches", matches: false }
    }
    return { kind: "matches", matches: true }
  } catch (error) {
    return malformed(
      Path.basename(dataPath, EnvelopeRecordFile.DataExt),
      formatError(error)
    )
  }
}

async function readBytes(
  dataPath: string,
  metadataPath: string,
  baseKey: string
): Promise<
  | {
      readonly kind: "bytes"
      readonly dataBytes: Buffer
      readonly metadataBytes: Buffer
    }
  | Extract<ReadMetricResult, { kind: "malformed" }>
> {
  try {
    const [dataBytes, metadataBytes] = await Promise.all([
      Fs.promises.readFile(dataPath),
      Fs.promises.readFile(metadataPath)
    ])
    return { kind: "bytes", dataBytes, metadataBytes }
  } catch (error) {
    return malformed(baseKey, formatError(error))
  }
}

function decodeMetric(
  key: string,
  epoch: number,
  endpointsType: DebugOutpostEndpointsType,
  checksum: string,
  readResult: { readonly dataBytes: Buffer; readonly metadataBytes: Buffer }
): ReadMetricResult {
  try {
    const envelope = Envelope.fromBinary(readResult.dataBytes),
      metadata = DebugEnvelopeMetadataRecord.fromBinary(
        readResult.metadataBytes
      ),
      byteSize = readResult.dataBytes.length
    return {
      kind: "metric",
      metric: {
        key,
        epoch,
        endpointsType,
        checksum,
        epochEnvelopeIndex: envelope.epochEnvelopeIndex,
        byteSize,
        saturationRatio: byteSize / MaxEnvelopeBytes,
        batchOpNames: metadata.batchOpNames
      }
    }
  } catch (error) {
    return malformed(key, formatError(error))
  }
}
