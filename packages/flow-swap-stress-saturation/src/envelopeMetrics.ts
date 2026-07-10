import {
  collectOppEnvelopeSaturationMetrics,
  MaxEnvelopeBytes,
  SaturatedEnvelopeMinBytes,
  SolanaRawTransactionBytesMax
} from "@wireio/test-opp-stress"
import type {
  MalformedOppEnvelopeRecord,
  OppEnvelopeMetric,
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationWindow
} from "@wireio/test-opp-stress"

export { MaxEnvelopeBytes, SaturatedEnvelopeMinBytes, SolanaRawTransactionBytesMax }

/** Inclusive filters for one stress phase's OPP envelope collection window. */
export type EnvelopeSaturationWindow = Omit<
  OppEnvelopeSaturationWindow,
  "saturationStrategy"
>

/** Decoded envelope metric used to decide whether one phase is near the byte cap. */
export type EnvelopeMetric = OppEnvelopeMetric

/** Malformed fixture report for skipped envelope pairs. */
export type MalformedEnvelopeRecord = MalformedOppEnvelopeRecord

/** Envelope saturation metrics for one stress phase and direction/window. */
export type EnvelopeSaturationMetrics = OppEnvelopeSaturationMetrics

/**
 * Collect OPP envelope saturation metrics using the swap stress byte-threshold strategy.
 *
 * @param storageDir Directory containing `.data` / `.metadata` OPP debug pairs.
 * @param window Direction and epoch/time filters for one stress phase.
 * @returns Envelope counts, byte sizes, near-cap status, and malformed-pair reports.
 */
export async function collectEnvelopeSaturationMetrics(
  storageDir: string,
  window: EnvelopeSaturationWindow = {}
): Promise<EnvelopeSaturationMetrics> {
  return collectOppEnvelopeSaturationMetrics(storageDir, {
    ...window,
    saturationStrategy: "byte_threshold"
  })
}
