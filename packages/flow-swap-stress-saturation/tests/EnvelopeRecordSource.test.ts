import { mkdtempSync } from "node:fs"
import Os from "node:os"
import Path from "node:path"

import type { EnvelopeIntegrityResult } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import {
  collectOppEnvelopeSaturationMetrics,
  envelopeIntegritySnapshot,
  filesystemEnvelopeSource,
  OppEnvelopeTelemetryHealthKind,
  projectSnapshotSaturationMetrics,
  SaturatedEnvelopeMinBytes,
  type EnvelopeMetricRecord,
  type EnvelopeMetricSnapshot,
  type EnvelopeRecordSource
} from "@wireio/test-flow-swap-stress-saturation/stress-engine/index.js"

const ByteThresholdWindow = { saturationStrategy: "byte_threshold" } as const

/** One saturating Ethereum-inbound record built without any filesystem origin. */
function saturatingRecord(epochIndex: number): EnvelopeMetricRecord {
  return {
    baseKey: `0000000${epochIndex}-DEPOT_OUTPOST_ETHEREUM-abcdef0123456789`,
    epochIndex,
    endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
    checksum: "abcdef0123456789",
    epochEnvelopeIndex: 0,
    dataBytes: new Uint8Array(SaturatedEnvelopeMinBytes),
    batchOpNames: ["batchop.a"]
  }
}

/** A collected snapshot carrying `records`, mirroring source candidate accounting. */
function collectedSnapshot(
  records: readonly EnvelopeMetricRecord[]
): EnvelopeMetricSnapshot {
  return {
    kind: "collected",
    records,
    candidateCount: records.length,
    issues: []
  }
}

describe("projectSnapshotSaturationMetrics", () => {
  it("projects saturation from a synthetic non-filesystem snapshot", () => {
    // Given: one near-cap record supplied directly, not read from disk.
    const snapshot = collectedSnapshot([saturatingRecord(7)])

    // When: the source-agnostic core projects the byte-threshold strategy.
    const metrics = projectSnapshotSaturationMetrics(snapshot, ByteThresholdWindow)

    // Then: byte size drives saturation with no filesystem provenance needed.
    expect(metrics.envelopeCount).toBe(1)
    expect(metrics.byteSizes).toEqual([SaturatedEnvelopeMinBytes])
    expect(metrics.saturated).toBe(true)
    expect(metrics.health.kind).toBe(OppEnvelopeTelemetryHealthKind.Healthy)
  })

  it("applies the epoch window to snapshot records", () => {
    // Given: an epoch-7 record and a window starting after it.
    const snapshot = collectedSnapshot([saturatingRecord(7)])

    // When: the window excludes the record's epoch.
    const metrics = projectSnapshotSaturationMetrics(snapshot, {
      ...ByteThresholdWindow,
      epochStart: 8
    })

    // Then: nothing matches and the phase is not saturated.
    expect(metrics.envelopeCount).toBe(0)
    expect(metrics.saturated).toBe(false)
  })

  it("reports an empty phase for a failed source", () => {
    // Given: a source that failed to read its backing store.
    const snapshot: EnvelopeMetricSnapshot = {
      kind: "source_failed",
      records: [],
      candidateCount: 0,
      issues: []
    }

    // When/Then: the projection degrades to an empty, unsaturated observation.
    const metrics = projectSnapshotSaturationMetrics(snapshot)
    expect(metrics.envelopeCount).toBe(0)
    expect(metrics.saturated).toBe(false)
    expect(metrics.health.kind).toBe(OppEnvelopeTelemetryHealthKind.Empty)
  })
})

describe("collectOppEnvelopeSaturationMetrics source overload", () => {
  it("collects from any EnvelopeRecordSource", async () => {
    // Given: an in-memory source, standing in for an on-chain/remote origin.
    const source: EnvelopeRecordSource = {
      snapshot: async () => collectedSnapshot([saturatingRecord(7)])
    }

    // When: the collector consumes the source instead of a directory.
    const metrics = await collectOppEnvelopeSaturationMetrics(
      source,
      ByteThresholdWindow
    )

    // Then: the same saturation result is produced from the source snapshot.
    expect(metrics.saturated).toBe(true)
    expect(metrics.envelopeCount).toBe(1)
  })
})

describe("filesystemEnvelopeSource", () => {
  it("reports an empty collected snapshot for an empty directory", async () => {
    // Given: an existing but empty debug-artifact directory.
    const storageDir = mkdtempSync(Path.join(Os.tmpdir(), "opp-empty-"))

    // When: the filesystem source reads it.
    const snapshot = await filesystemEnvelopeSource(storageDir).snapshot()

    // Then: it collects zero records rather than failing.
    expect(snapshot.kind).toBe("collected")
    expect(snapshot.records).toEqual([])
  })

  it("reports a failed snapshot for a missing directory", async () => {
    // Given: a path that does not exist.
    const missing = Path.join(
      mkdtempSync(Path.join(Os.tmpdir(), "opp-missing-")),
      "absent"
    )

    // When/Then: the strict scan failure surfaces as a source failure.
    const snapshot = await filesystemEnvelopeSource(missing).snapshot()
    expect(snapshot.kind).toBe("source_failed")
  })
})

describe("envelopeIntegritySnapshot", () => {
  it("maps a collected integrity result to a collected snapshot", () => {
    // Given: an empty collected strict-reader result.
    const result: EnvelopeIntegrityResult = {
      kind: "collected",
      candidates: [],
      valid: [],
      pending: [],
      issues: []
    }

    // When/Then: the mapping preserves the collected outcome.
    const snapshot = envelopeIntegritySnapshot(result)
    expect(snapshot.kind).toBe("collected")
    expect(snapshot.candidateCount).toBe(0)
  })

  it("maps a scan failure to a failed snapshot", () => {
    // Given: a strict-reader scan failure.
    const result: EnvelopeIntegrityResult = {
      kind: "scan_failed",
      candidates: [],
      valid: [],
      pending: [],
      issues: []
    }

    // When/Then: `scan_failed` becomes the source-agnostic `source_failed`.
    expect(envelopeIntegritySnapshot(result).kind).toBe("source_failed")
  })
})
