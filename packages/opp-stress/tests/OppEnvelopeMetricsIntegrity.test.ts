import { createHash } from "node:crypto"
import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType
} from "@wireio/opp-typescript-models"
import {
  collectOppEnvelopeSaturationMetrics,
  MaxEnvelopeBytes,
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode
} from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  MetricEndpointsType,
  MetricEpoch,
  removeMetricStorageDir,
  writeInvalidMetricPair,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"
import { MetricIntegrityCases } from "./oppEnvelopeMetricIntegrityCases.js"
import {
  duplicateFieldSaturationExploitBytes,
  DuplicateProtobufExploitByteLength
} from "./duplicateProtobufFieldTestSupport.js"
import {
  unknownFieldSaturationExploitBytes,
  UnknownProtobufExploitByteLength
} from "./unknownProtobufFieldTestSupport.js"

describe("strict OPP envelope metric collection", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = makeMetricStorageDir("integrity")
  })

  afterEach(() => {
    removeMetricStorageDir(storageDir)
  })

  it.each(MetricIntegrityCases)(
    "returns pending health for a candidate $label failure",
    async ({ arrange }) => {
      // Given: one candidate with the selected integrity defect.
      const expectedIssue = arrange(storageDir)

      // When: strict envelope metrics are collected.
      const metrics = await collectOppEnvelopeSaturationMetrics(storageDir)

      // Then: the candidate remains unaccounted and receives no saturation credit.
      expect(metrics.health).toMatchObject({
        kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
        candidateCount: 1,
        validCount: 0,
        filteredCount: 0,
        issueCount: 1,
        issues: [expectedIssue]
      })
      expect(metrics.health.issues).toEqual([expectedIssue])
      expect(metrics.envelopeCount).toBe(0)
      expect(metrics.saturated).toBe(false)
      expect(metrics.malformedRecords).toEqual([
        {
          key: expectedIssue.baseKey,
          reason: expectedIssue.code,
          issue: expectedIssue
        }
      ])
    }
  )

  it.each([
    {
      label: "data symlink",
      code: OppEnvelopeTelemetryIssueCode.DataSidecarSymlink,
      sidecar: "data",
      replacement: "symlink"
    },
    {
      label: "metadata symlink",
      code: OppEnvelopeTelemetryIssueCode.MetadataSidecarSymlink,
      sidecar: "metadata",
      replacement: "symlink"
    },
    {
      label: "data directory",
      code: OppEnvelopeTelemetryIssueCode.DataSidecarNotRegular,
      sidecar: "data",
      replacement: "directory"
    },
    {
      label: "metadata directory",
      code: OppEnvelopeTelemetryIssueCode.MetadataSidecarNotRegular,
      sidecar: "metadata",
      replacement: "directory"
    }
  ])("preserves the exact $label classification", async fixture => {
    // Given: one canonical pair whose selected sidecar is unsafe.
    const pair = writeMetricEnvelopeFixture(storageDir, 0),
      path = fixture.sidecar === "data" ? pair.dataPath : pair.metadataPath,
      target = Path.join(storageDir, "sidecar-target")
    Fs.rmSync(path)
    if (fixture.replacement === "symlink") {
      Fs.writeFileSync(target, "target")
      Fs.symlinkSync(target, path)
    } else {
      Fs.mkdirSync(path)
    }

    // When: strict envelope metrics are collected.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir)

    // Then: no unsafe sidecar contributes bytes or saturation evidence.
    expect(metrics.health.issues).toEqual([
      expect.objectContaining({ code: fixture.code, baseKey: pair.baseKey })
    ])
    expect(metrics.envelopeCount).toBe(0)
    expect(metrics.saturated).toBe(false)
  })

  it("keeps saturating valid diagnostics pending beside an invalid candidate", async () => {
    // Given: one near-cap valid pair and one malformed candidate.
    writeMetricEnvelopeFixture(storageDir, 0, {
      payloadSize: MaxEnvelopeBytes - 512
    })
    writeInvalidMetricPair(storageDir, "bad")

    // When: byte-threshold metrics are collected.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      saturationStrategy: "byte_threshold"
    })

    // Then: valid bytes remain diagnostic but pending health fails closed.
    expect(metrics).toMatchObject({ envelopeCount: 1, saturated: false })
    expect(metrics.health).toMatchObject({
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      candidateCount: 2,
      validCount: 1,
      filteredCount: 0,
      issueCount: 1
    })
    expect(metrics.malformedRecords[0]).toMatchObject({
      key: "bad",
      reason: OppEnvelopeTelemetryIssueCode.InvalidStorageKey,
      issue: { code: OppEnvelopeTelemetryIssueCode.InvalidStorageKey }
    })
  })

  it("reports healthy accounting when every valid candidate is filtered", async () => {
    // Given: one endpoint-mismatched pair and one epoch-mismatched pair.
    writeMetricEnvelopeFixture(storageDir, 0, {
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    })
    writeMetricEnvelopeFixture(storageDir, 1, { keyEpoch: MetricEpoch + 1 })

    // When: collection requests only the default endpoint and epoch.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      endpointsType: MetricEndpointsType,
      epochStart: MetricEpoch,
      epochEnd: MetricEpoch
    })

    // Then: filters account for both candidates without fabricating evidence.
    expect(metrics.health).toEqual({
      kind: OppEnvelopeTelemetryHealthKind.Healthy,
      retryable: false,
      candidateCount: 2,
      validCount: 0,
      filteredCount: 2,
      issueCount: 0,
      issues: []
    })
    expect(metrics.envelopes).toEqual([])
    expect(metrics.saturated).toBe(false)
  })

  it("rejects the hash-consistent 62,378-byte unknown-field saturation exploit", async () => {
    // Given: canonical Envelope bytes gain field 500 and all external checksums are recomputed.
    const dataBytes = unknownFieldSaturationExploitBytes(MetricEpoch),
      sha256 = createHash("sha256").update(dataBytes).digest("hex"),
      baseKey = `${String(MetricEpoch).padStart(8, "0")}-OUTPOST_ETHEREUM_DEPOT-${sha256.slice(0, 16)}`
    Fs.writeFileSync(Path.join(storageDir, `${baseKey}.data`), dataBytes)
    Fs.writeFileSync(
      Path.join(storageDir, `${baseKey}.metadata`),
      DebugEnvelopeMetadataRecord.toBinary(
        DebugEnvelopeMetadataRecord.create({
          checksum: BigInt(`0x${sha256.slice(0, 12)}`),
          batchOpNames: ["batchop.a"]
        })
      )
    )

    // When: strict byte-threshold metrics inspect the forged candidate.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      saturationStrategy: "byte_threshold"
    })

    // Then: raw size is unchanged, but rejected bytes receive no health or saturation credit.
    expect(dataBytes.byteLength).toBe(UnknownProtobufExploitByteLength)
    expect(metrics).toMatchObject({ envelopeCount: 0, saturated: false })
    expect(metrics.health).toMatchObject({
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      candidateCount: 1,
      validCount: 0,
      issueCount: 1,
      issues: [
        expect.objectContaining({
          code: OppEnvelopeTelemetryIssueCode.DataDecodeFailed,
          baseKey
        })
      ]
    })
  })

  it("rejects the hash-consistent 62,377-byte duplicate-known-field saturation exploit", async () => {
    // Given: canonical Envelope bytes gain a duplicate of singular field 1 and
    // every external checksum is recomputed over the padded bytes.
    const dataBytes = duplicateFieldSaturationExploitBytes(MetricEpoch),
      sha256 = createHash("sha256").update(dataBytes).digest("hex"),
      baseKey = `${String(MetricEpoch).padStart(8, "0")}-OUTPOST_ETHEREUM_DEPOT-${sha256.slice(0, 16)}`
    Fs.writeFileSync(Path.join(storageDir, `${baseKey}.data`), dataBytes)
    Fs.writeFileSync(
      Path.join(storageDir, `${baseKey}.metadata`),
      DebugEnvelopeMetadataRecord.toBinary(
        DebugEnvelopeMetadataRecord.create({
          checksum: BigInt(`0x${sha256.slice(0, 12)}`),
          batchOpNames: ["batchop.a"]
        })
      )
    )

    // When: strict byte-threshold metrics inspect the forged candidate.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir, {
      saturationStrategy: "byte_threshold"
    })

    // Then: padding that decodes to the correct epoch still earns no credit.
    expect(dataBytes.byteLength).toBe(DuplicateProtobufExploitByteLength)
    expect(metrics).toMatchObject({ envelopeCount: 0, saturated: false })
    expect(metrics.health).toMatchObject({
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      candidateCount: 1,
      validCount: 0,
      issueCount: 1,
      issues: [
        expect.objectContaining({
          code: OppEnvelopeTelemetryIssueCode.DataDecodeFailed,
          baseKey
        })
      ]
    })
  })
})
