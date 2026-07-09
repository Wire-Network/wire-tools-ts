import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"
import { createHash } from "node:crypto"

import {
  AttestationType,
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  endpointsTypeToKey,
  EnvelopeRecordFile
} from "@wireio/debugging-shared"
import {
  collectEnvelopeSaturationMetrics,
  MaxEnvelopeBytes,
  SolanaRawTransactionBytesMax
} from "@wireio/test-flow-swap-stress-saturation"

import { EnvelopeMetricFixtures } from "./constants.js"

describe("collectEnvelopeSaturationMetrics", () => {
  it("reports one matching envelope as not saturated", async () => {
    // Given: one valid fixture in the target direction and epoch window.
    const storageDir = makeStorageDir("single")
    writeEnvelopeFixture(storageDir, 0)

    // When: metrics are collected for that same phase window.
    const metrics = await collectEnvelopeSaturationMetrics(storageDir, {
      endpointsType: EnvelopeMetricFixtures.EndpointsType,
      epochStart: EnvelopeMetricFixtures.EpochIndex,
      epochEnd: EnvelopeMetricFixtures.EpochIndex
    })

    // Then: the single envelope is counted but rollover saturation is false.
    expect(metrics.envelopeCount).toBe(1)
    expect(metrics.saturated).toBe(false)
    expect(metrics.epochEnvelopeIndexes).toEqual([0])
    expect(metrics.byteSizes).toHaveLength(1)
    expect(metrics.malformedRecords).toEqual([])
  })

  it("reports one oversized DEPOT_OUTPOST_SOLANA envelope as diagnostic-only", async () => {
    // Given: one Solana-bound fixture whose raw envelope bytes exceed the Solana tx cap.
    const storageDir = makeStorageDir("oversized")
    writeEnvelopeFixture(storageDir, 0, {
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
      payloadSize: SolanaRawTransactionBytesMax + 768
    })

    // When: metrics are collected for the Solana destination direction.
    const metrics = await collectEnvelopeSaturationMetrics(storageDir, {
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
      epochStart: EnvelopeMetricFixtures.EpochIndex,
      epochEnd: EnvelopeMetricFixtures.EpochIndex
    })

    // Then: the single oversized envelope is visible but not treated as rollover saturation.
    expect(metrics.envelopeCount).toBe(1)
    expect(metrics.saturated).toBe(false)
    expect(metrics.solanaOversized).toBe(true)
    expect(metrics.byteSizes[0]).toBeGreaterThan(SolanaRawTransactionBytesMax)
    expect(metrics.envelopes[0].endpointsType).toBe(
      DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    )
    expect(metrics.malformedRecords).toEqual([])
  })

  it("does not report multiple tiny matching envelopes as saturated", async () => {
    // Given: two tiny valid fixtures for the same direction and epoch window.
    const storageDir = makeStorageDir("multi")
    writeEnvelopeFixture(storageDir, 0)
    writeEnvelopeFixture(storageDir, 1)

    // When: metrics are collected for the target direction.
    const metrics = await collectEnvelopeSaturationMetrics(storageDir, {
      endpointsType: EnvelopeMetricFixtures.EndpointsType,
      epochStart: EnvelopeMetricFixtures.EpochIndex,
      epochEnd: EnvelopeMetricFixtures.EpochIndex
    })

    // Then: rollover alone is diagnostic, not saturation proof.
    expect(metrics.envelopeCount).toBe(2)
    expect(metrics.saturated).toBe(false)
    expect(metrics.epochEnvelopeIndexes).toEqual([0, 1])
    expect(metrics.malformedRecords).toEqual([])
  })

  it("reports a near-max matching envelope as saturated", async () => {
    // Given: one valid fixture whose raw OPP envelope bytes are near the protocol cap.
    const storageDir = makeStorageDir("near-max")
    writeEnvelopeFixture(storageDir, 0, { payloadSize: MaxEnvelopeBytes - 512 })

    // When: metrics are collected for the target direction.
    const metrics = await collectEnvelopeSaturationMetrics(storageDir, {
      endpointsType: EnvelopeMetricFixtures.EndpointsType,
      epochStart: EnvelopeMetricFixtures.EpochIndex,
      epochEnd: EnvelopeMetricFixtures.EpochIndex
    })

    // Then: near-max raw OPP envelope evidence marks saturation.
    expect(metrics.envelopeCount).toBe(1)
    expect(metrics.saturated).toBe(true)
    expect(metrics.byteSizes[0]).toBeGreaterThanOrEqual(MaxEnvelopeBytes - 512)
    expect(metrics.malformedRecords).toEqual([])
  })

  it("ignores and reports malformed fixtures without failing collection", async () => {
    // Given: one valid envelope plus one malformed data/metadata pair.
    const storageDir = makeStorageDir("malformed")
    writeEnvelopeFixture(storageDir, 0)
    writeMalformedFixture(storageDir)

    // When: metrics are collected from the mixed directory.
    const metrics = await collectEnvelopeSaturationMetrics(storageDir, {
      endpointsType: EnvelopeMetricFixtures.EndpointsType
    })

    // Then: valid metrics survive and the bad fixture is reported by key.
    expect(metrics.envelopeCount).toBe(1)
    expect(metrics.saturated).toBe(false)
    expect(metrics.malformedRecords.map(record => record.key)).toEqual([
      malformedBaseKey()
    ])
  })
})

function makeStorageDir(label: string): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), `swap-stress-${label}-`))
}

function writeEnvelopeFixture(
  storageDir: string,
  epochEnvelopeIndex: number,
  options: {
    readonly endpointsType?: DebugOutpostEndpointsType
    readonly payloadSize?: number
  } = {}
): void {
  const payloadSize = options.payloadSize ?? 0,
    payload = new Uint8Array(payloadSize)
  payload.fill(1)
  const includePayload =
      options.endpointsType !== undefined || payload.length > 0,
    envelope = Envelope.create({
      epochIndex: EnvelopeMetricFixtures.EpochIndex,
      epochEnvelopeIndex,
      epochTimestamp: EnvelopeMetricFixtures.EpochTimestamp,
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32),
      messages: includePayload
        ? [
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
        : []
    }),
    bytes = Envelope.toBinary(envelope),
    checksum = createHash("sha256")
      .update(Buffer.from(bytes))
      .digest("hex")
      .substring(0, EnvelopeMetricFixtures.ChecksumHexChars),
    endpointsType =
      options.endpointsType ?? EnvelopeMetricFixtures.EndpointsType,
    endpointsKey = endpointsTypeToKey(endpointsType),
    epochStr = String(EnvelopeMetricFixtures.EpochIndex).padStart(
      EnvelopeMetricFixtures.EpochIndexPadWidth,
      "0"
    )
  if (endpointsKey === null) {
    throw new Error("test fixture endpoint type must resolve to a key")
  }
  const baseKey = `${epochStr}-${endpointsKey}-${checksum}`
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
    Buffer.from("not an envelope")
  )
  Fs.writeFileSync(
    Path.join(storageDir, `${baseKey}${EnvelopeRecordFile.MetadataExt}`),
    Buffer.from("not metadata")
  )
}

function malformedBaseKey(): string {
  return `000000${EnvelopeMetricFixtures.EpochIndex}-${DebugOutpostEndpointsType[EnvelopeMetricFixtures.EndpointsType]}-badbadbadbadbad0`
}
