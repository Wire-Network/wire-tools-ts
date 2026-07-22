import * as Fs from "node:fs"
import {
  createEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  collectOppEnvelopeSaturationMetrics,
  MaxEnvelopeBytes,
  OppEnvelopeTelemetryHealthKind,
  SolanaRawTransactionBytesMax
} from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  MetricEpoch,
  removeMetricStorageDir,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"

describe("collectOppEnvelopeSaturationMetrics", () => {
  it("reports rollover saturation from a healthy strict snapshot", async () => {
    // Given: two valid envelope pairs in the OPP debug directory.
    const storageDir = makeMetricStorageDir("rollover")
    writeMetricEnvelopeFixture(storageDir, 0)
    writeMetricEnvelopeFixture(storageDir, 1)

    // When: metrics are collected for the matching endpoint.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      epochStart: MetricEpoch,
      epochEnd: MetricEpoch
    })

    // Then: rollover is classified only with fully accounted healthy evidence.
    expect(metrics.saturated).toBe(true)
    expect(metrics.envelopeCount).toBe(2)
    expect(metrics.epochEnvelopeIndexes).toEqual([0, 1])
    expect(metrics.health).toEqual({
      kind: OppEnvelopeTelemetryHealthKind.Healthy,
      retryable: false,
      candidateCount: 2,
      validCount: 2,
      filteredCount: 0,
      issueCount: 0,
      issues: []
    })
    removeMetricStorageDir(storageDir)
  })

  it("flags oversized Solana destination envelopes as diagnostic metrics", async () => {
    // Given: one Solana-bound envelope exceeds the raw transaction size cap.
    const storageDir = makeMetricStorageDir("solana")
    writeMetricEnvelopeFixture(storageDir, 0, {
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
      payloadSize: SolanaRawTransactionBytesMax + 1
    })

    // When: metrics are collected for Solana destination evidence.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    })

    // Then: the oversized payload is visible without requiring rollover.
    expect(metrics.saturated).toBe(false)
    expect(metrics.solanaOversized).toBe(true)
    expect(metrics.byteSizes[0]).toBeGreaterThan(SolanaRawTransactionBytesMax)
    removeMetricStorageDir(storageDir)
  })

  it("does not report saturation for one envelope in each of two epochs", async () => {
    // Given: two epochs each contain only the first envelope index.
    const storageDir = makeMetricStorageDir("cross-epoch")
    writeMetricEnvelopeFixture(storageDir, 0, { keyEpoch: 7 })
    writeMetricEnvelopeFixture(storageDir, 0, { keyEpoch: 8 })

    // When: metrics are collected across both epochs.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      epochStart: 7,
      epochEnd: 8
    })

    // Then: multiple epochs without rollover are not classified as saturation.
    expect(metrics.envelopeCount).toBe(2)
    expect(metrics.epochEnvelopeIndexes).toEqual([0, 0])
    expect(metrics.saturated).toBe(false)
    removeMetricStorageDir(storageDir)
  })

  it("reports near-max byte saturation when the byte-threshold strategy is selected", async () => {
    // Given: one matching envelope is near the raw OPP envelope cap without rollover.
    const storageDir = makeMetricStorageDir("near-max")
    writeMetricEnvelopeFixture(storageDir, 0, {
      payloadSize: MaxEnvelopeBytes - 512
    })

    // When: metrics are collected with the byte-threshold strategy.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      saturationStrategy: "byte_threshold"
    })

    // Then: near-cap bytes classify saturation independently from rollover.
    expect(metrics.saturated).toBe(true)
    expect(metrics.epochEnvelopeIndexes).toEqual([0])
    expect(metrics.byteSizes[0]).toBeGreaterThanOrEqual(MaxEnvelopeBytes - 512)
    removeMetricStorageDir(storageDir)
  })

  it("projects cluster OPP debug artifacts into phase metrics", async () => {
    // Given: an OPP debug artifact under the canonical cluster-path-derived directory.
    const clusterPath = makeMetricStorageDir("cluster"),
      storageDir = oppDebuggingPath(clusterPath)
    Fs.mkdirSync(storageDir, { recursive: true })
    writeMetricEnvelopeFixture(storageDir, 0)
    writeMetricEnvelopeFixture(storageDir, 1)

    // When: phase metrics are collected from the cluster path.
    const metrics = await collectOppPhaseMetrics(clusterPath, {
      phase: "phase-a",
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      startedAtMs: "0",
      endedAtMs: `${BigInt(Number.MAX_SAFE_INTEGER)}`,
      epochStart: MetricEpoch,
      epochEnd: MetricEpoch,
      baseline: { ...createEnvelopeBaseline([]), artifactRefs: [] },
      evidenceSink: null
    })

    // Then: the phase result exposes ramp-ready envelope telemetry.
    expect(metrics).toMatchObject({
      phase: "phase-a",
      saturated: true,
      envelopeCount: 2,
      endpoint: "OUTPOST_ETHEREUM_DEPOT",
      strategy: "rollover",
      window: {
        epochStart: String(MetricEpoch),
        epochEnd: String(MetricEpoch)
      },
      evidence: { kind: "not_recorded" }
    })
    expect(metrics.envelopeByteSizes).toHaveLength(2)
    removeMetricStorageDir(clusterPath)
  })
})
