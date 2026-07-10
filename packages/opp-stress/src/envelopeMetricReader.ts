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

import { MaxEnvelopeBytes } from "./envelopeMetricTypes.js"
import type {
  OppEnvelopeSaturationWindow,
  ReadMetricResult,
  TimestampWindowResult
} from "./envelopeMetricTypes.js"

type DecodeMetricInput = {
  readonly key: string
  readonly epoch: number
  readonly endpointsType: DebugOutpostEndpointsType
  readonly checksum: string
  readonly readResult: {
    readonly dataBytes: Buffer
    readonly metadataBytes: Buffer
  }
}

/**
 * Read and decode one storage-key pair when it matches the requested window.
 *
 * @param storageDir Directory containing OPP debug artifacts.
 * @param baseKey Storage key without `.data` or `.metadata` suffix.
 * @param window Direction, epoch, and timestamp filters.
 * @returns Decoded metric, malformed record, or filtered marker.
 */
export async function readMetric(
  storageDir: string,
  baseKey: string,
  window: OppEnvelopeSaturationWindow
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

  return decodeMetric({
    key: baseKey,
    epoch: parsed.epochIndex,
    endpointsType,
    checksum: parsed.checksum,
    readResult
  })
}

/**
 * Build a malformed-pair record for skipped envelope pairs.
 *
 * @param key Storage key associated with the malformed pair.
 * @param reason Human-readable skip reason.
 * @returns Malformed read result.
 */
export function malformed(
  key: string,
  reason: string
): Extract<ReadMetricResult, { readonly kind: "malformed" }> {
  return { kind: "malformed", record: { key, reason } }
}

function matchesWindow(
  epoch: number,
  endpointsType: DebugOutpostEndpointsType,
  window: OppEnvelopeSaturationWindow
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
  window: OppEnvelopeSaturationWindow
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
    if (error instanceof Error) {
      return malformed(
        Path.basename(dataPath, EnvelopeRecordFile.DataExt),
        error.message
      )
    }
    return malformed(
      Path.basename(dataPath, EnvelopeRecordFile.DataExt),
      String(error)
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
  | Extract<ReadMetricResult, { readonly kind: "malformed" }>
> {
  try {
    const [dataBytes, metadataBytes] = await Promise.all([
      Fs.promises.readFile(dataPath),
      Fs.promises.readFile(metadataPath)
    ])
    return { kind: "bytes", dataBytes, metadataBytes }
  } catch (error) {
    if (error instanceof Error) return malformed(baseKey, error.message)
    return malformed(baseKey, String(error))
  }
}

function decodeMetric(input: DecodeMetricInput): ReadMetricResult {
  try {
    const envelope = Envelope.fromBinary(input.readResult.dataBytes),
      metadata = DebugEnvelopeMetadataRecord.fromBinary(
        input.readResult.metadataBytes
      ),
      byteSize = input.readResult.dataBytes.length
    return {
      kind: "metric",
      metric: {
        key: input.key,
        epoch: input.epoch,
        endpointsType: input.endpointsType,
        checksum: input.checksum,
        epochEnvelopeIndex: envelope.epochEnvelopeIndex,
        byteSize,
        saturationRatio: byteSize / MaxEnvelopeBytes,
        batchOpNames: metadata.batchOpNames
      }
    }
  } catch (error) {
    if (error instanceof Error) return malformed(input.key, error.message)
    return malformed(input.key, String(error))
  }
}
