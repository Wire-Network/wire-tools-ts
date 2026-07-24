import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  projectSnapshotSaturationMetrics,
  SaturatedEnvelopeMinBytes,
  type EnvelopeMetricRecord
} from "@wireio/test-opp-stress"

import { formatSaturationSummary } from "@wireio/opp-stress-harness"

/** A saturating Ethereum-inbound record, as a chain source would emit. */
function saturatingRecord(): EnvelopeMetricRecord {
  return {
    baseKey: "00000007-DEPOT_OUTPOST_ETHEREUM-abcdef0123456789",
    epochIndex: 7,
    endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
    checksum: "abcdef0123456789",
    epochEnvelopeIndex: 0,
    dataBytes: new Uint8Array(SaturatedEnvelopeMinBytes),
    batchOpNames: []
  }
}

describe("formatSaturationSummary", () => {
  it("renders the verdict, counts, health, and per-envelope lines", () => {
    // Given: metrics projected from one saturating record.
    const metrics = projectSnapshotSaturationMetrics(
      {
        kind: "collected",
        records: [saturatingRecord()],
        candidateCount: 1,
        issues: []
      },
      { saturationStrategy: "byte_threshold" }
    )

    // When: the summary is rendered.
    const summary = formatSaturationSummary(metrics)

    // Then: it reports saturation, the count, health, and the direction line.
    expect(summary).toContain("saturated: true")
    expect(summary).toContain("envelopes: 1")
    expect(summary).toContain("health:    healthy")
    expect(summary).toContain(
      `DEPOT_OUTPOST_ETHEREUM: ${SaturatedEnvelopeMinBytes} bytes (epoch 7)`
    )
  })

  it("renders an empty, unsaturated summary with no envelope lines", () => {
    // Given: a failed/empty source snapshot.
    const metrics = projectSnapshotSaturationMetrics({
      kind: "source_failed",
      records: [],
      candidateCount: 0,
      issues: []
    })

    // When/Then: the header reports zero envelopes and no saturation.
    const summary = formatSaturationSummary(metrics)
    expect(summary).toContain("saturated: false")
    expect(summary).toContain("envelopes: 0")
    expect(summary.split("\n")).toHaveLength(4)
  })
})
