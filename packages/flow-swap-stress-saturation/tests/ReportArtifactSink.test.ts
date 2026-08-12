import * as Crypto from "node:crypto"
import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { ReportArtifactSink } from "@wireio/test-flow-swap-stress-saturation/stress-engine/index.js"

const BaseKey = "00000042-OUTPOST_ETHEREUM_DEPOT-abc123def4567890"

function newReportPath(): string {
  return Fs.mkdtempSync(Path.join(OS.tmpdir(), "report-artifact-sink-"))
}

function sha256(bytes: Buffer): string {
  return Crypto.createHash("sha256").update(bytes).digest("hex")
}

describe("ReportArtifactSink", () => {
  let reportPath: string

  beforeEach(() => {
    reportPath = newReportPath()
  })

  afterEach(() => {
    Fs.rmSync(reportPath, { recursive: true, force: true })
  })

  it("commits both sidecar files under the report's artifact directory", async () => {
    // Given: a sink rooted at a report directory.
    const sink = ReportArtifactSink.create(reportPath),
      dataBytes = Buffer.from("envelope-bytes"),
      metadataBytes = Buffer.from('{"size":14}')

    // When: one pair is captured.
    const refs = await sink.beginObservation("1").captureArtifact({
      baseKey: BaseKey,
      dataBytes,
      metadataBytes
    })

    // Then: both land under reports/artifacts/opp with their true digests.
    const expectedRoot = Path.join(
      reportPath,
      ReportArtifactSink.ArtifactSubpath
    )
    expect(Path.dirname(refs.data.path)).toBe(expectedRoot)
    expect(Path.dirname(refs.metadata.path)).toBe(expectedRoot)
    expect(refs.data.sha256).toBe(sha256(dataBytes))
    expect(refs.metadata.sha256).toBe(sha256(metadataBytes))
    expect(Fs.readFileSync(refs.data.path)).toEqual(dataBytes)
    expect(Fs.readFileSync(refs.metadata.path)).toEqual(metadataBytes)
  })

  it("is idempotent — re-capturing identical bytes resolves to the same file", async () => {
    // Given: the same pair captured by two different observations.
    const sink = ReportArtifactSink.create(reportPath),
      capture = {
        baseKey: BaseKey,
        dataBytes: Buffer.from("envelope-bytes"),
        metadataBytes: Buffer.from("metadata-bytes")
      }

    // When: the second observation captures it again.
    const first = await sink.beginObservation("1").captureArtifact(capture),
      second = await sink.beginObservation("2").captureArtifact(capture)

    // Then: content addressing collapses them onto one immutable file rather
    // than colliding — AtomicFile.create alone is create-only and would throw.
    expect(second.data.path).toBe(first.data.path)
    expect(second.data.sha256).toBe(first.data.sha256)
    expect(
      Fs.readdirSync(Path.join(reportPath, ReportArtifactSink.ArtifactSubpath))
    ).toHaveLength(2)
  })

  it("separates differing bytes for one base key by digest", async () => {
    // Given: the same key observed with different envelope bytes.
    const sink = ReportArtifactSink.create(reportPath),
      metadataBytes = Buffer.from("metadata-bytes")

    // When: both are captured.
    const first = await sink.beginObservation("1").captureArtifact({
        baseKey: BaseKey,
        dataBytes: Buffer.from("first-bytes"),
        metadataBytes
      }),
      second = await sink.beginObservation("2").captureArtifact({
        baseKey: BaseKey,
        dataBytes: Buffer.from("second-bytes"),
        metadataBytes
      })

    // Then: neither overwrites the other — both remain recoverable.
    expect(second.data.path).not.toBe(first.data.path)
    expect(Fs.readFileSync(first.data.path).toString()).toBe("first-bytes")
    expect(Fs.readFileSync(second.data.path).toString()).toBe("second-bytes")
  })

  it("allocates a monotonic ordinal per observation", () => {
    // Given: one sink.
    const sink = ReportArtifactSink.create(reportPath)

    // When/Then: each observation takes the next ordinal.
    expect(sink.beginObservation("1").ordinal).toBe("1")
    expect(sink.beginObservation("2").ordinal).toBe("2")
    expect(sink.beginObservation("3").ordinal).toBe("3")
  })
})
