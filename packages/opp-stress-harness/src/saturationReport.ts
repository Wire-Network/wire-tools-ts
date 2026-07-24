import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import type { OppEnvelopeSaturationMetrics } from "@wireio/test-opp-stress"

/**
 * Render a human-readable OPP saturation summary for CLI stdout.
 *
 * One header block (saturation verdict, envelope count, telemetry health) plus
 * one line per observed envelope (direction, byte size, epoch). Machine
 * consumers should request JSON instead.
 *
 * @param metrics Saturation metrics from an envelope record source.
 * @returns A multi-line summary string (no trailing newline).
 */
export function formatSaturationSummary(
  metrics: OppEnvelopeSaturationMetrics
): string {
  const header = [
      "OPP envelope saturation (byte_threshold)",
      `  saturated: ${metrics.saturated}`,
      `  envelopes: ${metrics.envelopeCount}`,
      `  health:    ${metrics.health.kind}`
    ],
    perEnvelope = metrics.envelopes.map(
      envelope =>
        `  ${DebugOutpostEndpointsType[envelope.endpointsType]}: ` +
        `${envelope.byteSize} bytes (epoch ${envelope.epoch})`
    )
  return [...header, ...perEnvelope].join("\n")
}
