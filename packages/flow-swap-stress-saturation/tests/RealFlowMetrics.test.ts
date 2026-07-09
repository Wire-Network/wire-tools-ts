import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"
import { createHash } from "node:crypto"

import {
  oppDebuggingPath,
  endpointsTypeToKey,
  EnvelopeRecordFile
} from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"
import { MaxEnvelopeBytes } from "@wireio/test-flow-swap-stress-saturation"

import { EnvelopeMetricFixtures } from "./constants.js"
import { collectPhaseMetrics } from "./real/realFlowUtils.js"

describe("collectPhaseMetrics", () => {
  it("waits for delayed endpoint evidence and extends the metrics window", async () => {
    // Given: the phase ended before OPP debug files were flushed to disk.
    const clusterPath = makeClusterPath(),
      storageDir = oppDebuggingPath(clusterPath),
      collection = collectPhaseMetrics(
        clusterPath,
        {
          phase: "phase-2",
          startedAtMs: 1,
          endedAtMs: 2,
          endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
        },
        { evidenceTimeoutMs: 250, evidencePollIntervalMs: 1 }
      )

    // When: matching evidence arrives after collection has already started.
    setTimeout(() => {
      writeEnvelopeFixture(
        storageDir,
        0,
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        MaxEnvelopeBytes - 512
      )
      writeEnvelopeFixture(
        storageDir,
        1,
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
      )
    }, 5)

    const metrics = await collection

    // Then: late files are included instead of being filtered by the original end time.
    expect(metrics.saturated).toBe(true)
    expect(metrics.envelopeCount).toBe(2)
    expect(metrics.endpoint).toBe("DEPOT_OUTPOST_ETHEREUM")
    expect(metrics.epochStart).toBe(EnvelopeMetricFixtures.EpochIndex)
    expect(metrics.epochEnd).toBe(EnvelopeMetricFixtures.EpochIndex)
  })
})

function makeClusterPath(): string {
  const clusterPath = Fs.mkdtempSync(
    Path.join(OS.tmpdir(), "swap-stress-real-metrics-")
  )
  Fs.mkdirSync(oppDebuggingPath(clusterPath), { recursive: true })
  return clusterPath
}

function writeEnvelopeFixture(
  storageDir: string,
  epochEnvelopeIndex: number,
  endpointsType: DebugOutpostEndpointsType,
  payloadSize = 1
): void {
  const endpointsKey = endpointsTypeToKey(endpointsType)
  if (endpointsKey === null)
    throw new Error("test fixture endpoint type must resolve to a key")

  const payload = new Uint8Array(payloadSize)
  payload.fill(1)
  const envelope = Envelope.create({
      epochIndex: EnvelopeMetricFixtures.EpochIndex,
      epochEnvelopeIndex,
      epochTimestamp: EnvelopeMetricFixtures.EpochTimestamp,
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
      .substring(0, EnvelopeMetricFixtures.ChecksumHexChars),
    epochStr = String(EnvelopeMetricFixtures.EpochIndex).padStart(
      EnvelopeMetricFixtures.EpochIndexPadWidth,
      "0"
    ),
    baseKey = `${epochStr}-${endpointsKey}-${checksum}`

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
