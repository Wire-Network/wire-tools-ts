import {
  collectOppEnvelopeSaturationMetrics,
  MaxEnvelopeBytes,
  SolanaRawTransactionBytesMax
} from "@wireio/test-opp-stress"
import type {
  OppEnvelopeSaturationMetrics,
  OppEnvelopeSaturationWindow
} from "@wireio/test-opp-stress"

export { MaxEnvelopeBytes, SolanaRawTransactionBytesMax }

/** Inclusive filters for one stress phase's OPP envelope collection window. */
export type EnvelopeSaturationWindow = Omit<
  OppEnvelopeSaturationWindow,
  "saturationStrategy"
>

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
