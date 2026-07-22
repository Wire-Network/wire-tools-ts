import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { OppEnvelopeTelemetryHealthKind } from "@wireio/test-opp-stress"
import {
  SolanaRawTransactionBytesMax,
  type SwapStressMeasuredPhaseEnvelopeMetrics
} from "@wireio/test-flow-swap-stress-saturation"

type StrictSnapshotSummary = Pick<
  SwapStressMeasuredPhaseEnvelopeMetrics,
  | "phase"
  | "saturated"
  | "envelopeCount"
  | "envelopeByteSizes"
  | "endpoint"
  | "epochStart"
  | "epochEnd"
>

/**
 * Build coherent measured strict-snapshot telemetry for typed flow fixtures.
 * @param summary Existing flat phase summary fields.
 * @returns Healthy measured metrics with strict-snapshot provenance.
 */
export function strictSnapshotMetrics(
  summary: StrictSnapshotSummary
): SwapStressMeasuredPhaseEnvelopeMetrics {
  const epochEnvelopeIndexes = summary.envelopeByteSizes.map(
      (_byteSize, index) => index
    ),
    solanaOversized =
      summary.endpoint ===
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
        ] &&
      summary.envelopeByteSizes.some(
        byteSize => byteSize > SolanaRawTransactionBytesMax
      )
  return {
    ...summary,
    measurement: "measured",
    health: {
      kind: OppEnvelopeTelemetryHealthKind.Healthy,
      retryable: false,
      candidateCount: summary.envelopeCount,
      validCount: summary.envelopeCount,
      filteredCount: 0,
      issueCount: 0,
      issues: []
    },
    malformedRecords: [],
    artifactRefs: [],
    provenance: {
      kind: "strict_snapshot",
      solanaOversized,
      epochEnvelopeIndexes
    }
  }
}
