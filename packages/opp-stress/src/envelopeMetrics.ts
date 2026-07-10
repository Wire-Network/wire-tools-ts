import * as Fs from "node:fs"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { EnvelopeRecordFile } from "@wireio/debugging-shared"

import { readMetric } from "./envelopeMetricReader.js"
import {
  SaturatedEnvelopeMinBytes,
  SolanaRawTransactionBytesMax
} from "./envelopeMetricTypes.js"
import type {
  OppEnvelopeMetric,
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationStrategy,
  OppEnvelopeSaturationWindow,
  ReadMetricResult
} from "./envelopeMetricTypes.js"

export {
  MaxEnvelopeBytes,
  SaturatedEnvelopeMinBytes,
  SolanaRawTransactionBytesMax
} from "./envelopeMetricTypes.js"
export type {
  MalformedOppEnvelopeRecord,
  OppEnvelopeMetric,
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationStrategy,
  OppEnvelopeSaturationWindow
} from "./envelopeMetricTypes.js"

/**
 * Collect OPP envelope saturation metrics from a debugging storage directory.
 *
 * @param storageDir Directory containing `.data` / `.metadata` OPP debug pairs.
 * @param window Direction and epoch/time filters for one stress phase.
 * @returns Envelope counts, byte sizes, rollover status, and malformed-pair reports.
 */
export async function collectOppEnvelopeSaturationMetrics(
  storageDir: string,
  window: OppEnvelopeSaturationWindow = {}
): Promise<OppEnvelopeSaturationMetrics> {
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
        (
          result
        ): result is Extract<ReadMetricResult, { readonly kind: "metric" }> =>
          result.kind === "metric"
      )
      .map(result => result.metric)
      .sort(compareEnvelopeMetrics),
    malformedRecords = results
      .filter(
        (
          result
        ): result is Extract<
          ReadMetricResult,
          { readonly kind: "malformed" }
        > => result.kind === "malformed"
      )
      .map(result => result.record)

  return {
    saturated: saturatedByStrategy(
      window.saturationStrategy ?? "rollover",
      envelopes
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

function saturatedByStrategy(
  strategy: OppEnvelopeSaturationStrategy,
  envelopes: readonly OppEnvelopeMetric[]
): boolean {
  switch (strategy) {
    case "rollover":
      return envelopes.some(envelope => envelope.epochEnvelopeIndex > 0)
    case "byte_threshold":
      return envelopes.some(
        envelope => envelope.byteSize >= SaturatedEnvelopeMinBytes
      )
    default:
      return assertNever(strategy)
  }
}

function compareEnvelopeMetrics(
  left: OppEnvelopeMetric,
  right: OppEnvelopeMetric
): number {
  return (
    left.epoch - right.epoch ||
    left.epochEnvelopeIndex - right.epochEnvelopeIndex ||
    left.key.localeCompare(right.key)
  )
}

function emptyMetrics(): OppEnvelopeSaturationMetrics {
  return {
    saturated: false,
    solanaOversized: false,
    envelopeCount: 0,
    byteSizes: [],
    epochEnvelopeIndexes: [],
    envelopes: [],
    malformedRecords: []
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected OPP envelope strategy: ${String(value)}`)
}
