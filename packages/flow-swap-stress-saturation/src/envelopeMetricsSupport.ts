import type {
  EnvelopeMetric,
  EnvelopeSaturationMetrics,
  MalformedEnvelopeRecord
} from "./envelopeMetrics.js"

/** Sort envelope metrics into deterministic phase order. */
export function compareEnvelopeMetrics(
  left: EnvelopeMetric,
  right: EnvelopeMetric
): number {
  return (
    left.epoch - right.epoch ||
    left.epochEnvelopeIndex - right.epochEnvelopeIndex ||
    left.key.localeCompare(right.key)
  )
}

/** Build an empty saturation result for a phase with no matching envelopes. */
export function emptyMetrics(): EnvelopeSaturationMetrics {
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

/** Build a malformed-pair record for skipped envelope pairs. */
export function malformed(
  key: string,
  reason: string
): { readonly kind: "malformed"; readonly record: MalformedEnvelopeRecord } {
  return { kind: "malformed", record: { key, reason } }
}

/** Format a thrown value as a stable message. */
export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
