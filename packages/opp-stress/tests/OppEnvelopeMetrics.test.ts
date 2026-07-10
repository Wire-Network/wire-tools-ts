import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"
import { createHash } from "node:crypto"

import {
  endpointsTypeToKey,
  EnvelopeRecordFile,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  collectOppEnvelopeSaturationMetrics,
  MaxEnvelopeBytes,
  SolanaRawTransactionBytesMax
} from "@wireio/test-opp-stress"

describe("collectOppEnvelopeSaturationMetrics", () => {
  it("reports rollover saturation and malformed OPP records from a phase window", async () => {
    // Given: two valid envelope pairs and one malformed pair in the OPP debug directory.
    const storageDir = makeStorageDir("rollover")
    writeEnvelopeFixture(storageDir, 0)
    writeEnvelopeFixture(storageDir, 1)
    writeMalformedFixture(storageDir)

    // When: metrics are collected for the matching endpoint.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      epochStart: 7,
      epochEnd: 7
    })

    // Then: rollover is classified without discarding malformed evidence.
    expect(metrics.saturated).toBe(true)
    expect(metrics.envelopeCount).toBe(2)
    expect(metrics.epochEnvelopeIndexes).toEqual([0, 1])
    expect(metrics.malformedRecords.map(record => record.key)).toEqual([
      malformedBaseKey()
    ])
  })

  it("flags oversized Solana destination envelopes as diagnostic metrics", async () => {
    // Given: one Solana-bound envelope exceeds the raw transaction size cap.
    const storageDir = makeStorageDir("solana")
    writeEnvelopeFixture(storageDir, 0, {
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
  })

  it("does not report saturation for one envelope in each of two epochs", async () => {
    // Given: two epochs each contain only the first envelope index.
    const storageDir = makeStorageDir("cross-epoch")
    writeEnvelopeFixture(storageDir, 0, { epochIndex: 7 })
    writeEnvelopeFixture(storageDir, 0, { epochIndex: 8 })

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
  })

  it("reports near-max byte saturation when the byte-threshold strategy is selected", async () => {
    // Given: one matching envelope is near the raw OPP envelope cap without rollover.
    const storageDir = makeStorageDir("near-max")
    writeEnvelopeFixture(storageDir, 0, { payloadSize: MaxEnvelopeBytes - 512 })

    // When: metrics are collected with the byte-threshold strategy.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      saturationStrategy: "byte_threshold"
    })

    // Then: near-cap bytes classify saturation independently from rollover.
    expect(metrics.saturated).toBe(true)
    expect(metrics.epochEnvelopeIndexes).toEqual([0])
    expect(metrics.byteSizes[0]).toBeGreaterThanOrEqual(MaxEnvelopeBytes - 512)
  })

  it("projects cluster OPP debug artifacts into phase metrics", async () => {
    // Given: an OPP debug artifact under the canonical cluster-path-derived directory.
    const clusterPath = Fs.mkdtempSync(
        Path.join(OS.tmpdir(), "opp-stress-cluster-")
      ),
      storageDir = oppDebuggingPath(clusterPath)
    Fs.mkdirSync(storageDir, { recursive: true })
    writeEnvelopeFixture(storageDir, 0)
    writeEnvelopeFixture(storageDir, 1)

    // When: phase metrics are collected from the cluster path.
    const metrics = await collectOppPhaseMetrics(clusterPath, {
      phase: "phase-a",
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      startedAtMs: 0,
      endedAtMs: Number.MAX_SAFE_INTEGER
    })

    // Then: the phase result exposes ramp-ready envelope telemetry.
    expect(metrics).toMatchObject({
      phase: "phase-a",
      saturated: true,
      envelopeCount: 2,
      endpoint: "OUTPOST_ETHEREUM_DEPOT",
      epochStart: 7,
      epochEnd: 7
    })
    expect(metrics.envelopeByteSizes).toHaveLength(2)
  })
})

function makeStorageDir(label: string): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), `opp-stress-metrics-${label}-`))
}

function writeEnvelopeFixture(
  storageDir: string,
  epochEnvelopeIndex: number,
  options: {
    readonly endpointsType?: DebugOutpostEndpointsType
    readonly epochIndex?: number
    readonly payloadSize?: number
  } = {}
): void {
  const endpointsType =
      options.endpointsType ?? DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    epochIndex = options.epochIndex ?? 7,
    payloadSize = options.payloadSize ?? 0,
    payload = new Uint8Array(payloadSize)
  payload.fill(1)
  const envelope = Envelope.create({
      epochIndex,
      epochEnvelopeIndex,
      epochTimestamp: 1_000n,
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32),
      messages: [
        {
          payload: {
            version: 0,
            attestations: [
              {
                type: AttestationType.UNSPECIFIED,
                dataSize: payload.length,
                data: payload
              }
            ]
          }
        }
      ]
    }),
    bytes = Envelope.toBinary(envelope),
    checksum = createHash("sha256")
      .update(Buffer.from(bytes))
      .digest("hex")
      .substring(0, 16),
    endpointsKey = endpointsTypeToKey(endpointsType),
    baseKey = `${String(epochIndex).padStart(8, "0")}-${endpointsKey}-${checksum}`
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.DataExt}`),
    Buffer.from(bytes)
  )
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.MetadataExt}`),
    DebugEnvelopeMetadataRecord.toBinary(
      DebugEnvelopeMetadataRecord.create({ batchOpNames: ["batchop.a"] })
    )
  )
}

function writeMalformedFixture(storageDir: string): void {
  const baseKey = malformedBaseKey()
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.DataExt}`),
    Buffer.from("not envelope")
  )
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.MetadataExt}`),
    Buffer.from("not metadata")
  )
}

function malformedBaseKey(): string {
  return "00000007-OUTPOST_ETHEREUM_DEPOT-badbadbadbadbad0"
}
