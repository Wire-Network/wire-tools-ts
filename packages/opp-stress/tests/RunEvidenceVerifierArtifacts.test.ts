import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"
import {
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { verifierFixtureSha256 } from "./runEvidenceVerifierArtifactFixture.js"
import {
  arrayField,
  createVerifierFixture,
  objectField,
  readVerifierJson,
  recordValue,
  stringField,
  writeVerifierJson
} from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier raw artifact integrity", () => {
  it.each([
    [
      "data mutation",
      "data",
      Buffer.from([0xff]),
      RunEvidenceVerificationIssueCode.ArtifactHashMismatch
    ],
    [
      "metadata corruption",
      "metadata",
      Buffer.from([0xff]),
      RunEvidenceVerificationIssueCode.MetadataDecodeFailed
    ]
  ])("rejects %s", (_label, side, replacement, expectedCode) => {
    // Given: one immutable sidecar is replaced after run completion.
    const fixture = createVerifierFixture()
    try {
      if (side !== "data" && side !== "metadata")
        throw new Error("artifact side must be data or metadata")
      const target = artifactSide(fixture.runDirectory, side)
      Fs.writeFileSync(
        Path.join(fixture.runDirectory, stringField(target, "path")),
        replacement
      )
      if (side === "metadata")
        updateArtifactDigest(fixture.runDirectory, side, replacement)

      // When: exact sidecar bytes are independently decoded and hashed.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: mutation cannot retain saturation credit.
      expect(report.valid).toBe(false)
      expect(report.issues.map(issue => issue.code)).toContain(expectedCode)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects metadata checksum and empty operators with matching manifest hashes", () => {
    // Given: protobuf-valid metadata bytes violate two raw pair invariants.
    const fixture = createVerifierFixture()
    try {
      const metadata = artifactSide(fixture.runDirectory, "metadata"),
        bytes = Buffer.from(
          DebugEnvelopeMetadataRecord.toBinary(
            DebugEnvelopeMetadataRecord.create({
              checksum: 0n,
              batchOpNames: []
            })
          )
        )
      Fs.writeFileSync(
        Path.join(fixture.runDirectory, stringField(metadata, "path")),
        bytes
      )
      updateArtifactDigest(fixture.runDirectory, "metadata", bytes)

      // When: metadata is decoded independently of recorded telemetry.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: checksum and operator validity are both reported.
      const codes = report.issues.map(issue => issue.code)
      expect(codes).toContain(
        RunEvidenceVerificationIssueCode.MetadataChecksumMismatch
      )
      expect(codes).toContain(RunEvidenceVerificationIssueCode.InvalidOperators)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects a decoded epoch mismatch even when the data ref hash is updated", () => {
    // Given: protobuf-valid data claims a different epoch than its canonical key.
    const fixture = createVerifierFixture()
    try {
      const data = artifactSide(fixture.runDirectory, "data"),
        dataFile = Path.join(fixture.runDirectory, stringField(data, "path")),
        decoded = Envelope.fromBinary(Fs.readFileSync(dataFile)),
        bytes = Buffer.from(
          Envelope.toBinary(
            Envelope.create({ ...decoded, epochIndex: decoded.epochIndex + 1 })
          )
        )
      Fs.writeFileSync(dataFile, bytes)
      updateArtifactDigest(fixture.runDirectory, "data", bytes)

      // When: key identity and decoded Envelope identity are compared.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: epoch mismatch remains visible despite a matching manifest digest.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.EpochMismatch
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects swapped data and metadata files", () => {
    // Given: both declared sidecar paths contain the opposite valid bytes.
    const fixture = createVerifierFixture()
    try {
      const data = artifactSide(fixture.runDirectory, "data"),
        metadata = artifactSide(fixture.runDirectory, "metadata"),
        dataFile = Path.join(fixture.runDirectory, stringField(data, "path")),
        metadataFile = Path.join(
          fixture.runDirectory,
          stringField(metadata, "path")
        ),
        dataBytes = Fs.readFileSync(dataFile),
        metadataBytes = Fs.readFileSync(metadataFile)
      Fs.writeFileSync(dataFile, metadataBytes)
      Fs.writeFileSync(metadataFile, dataBytes)
      updateArtifactDigest(fixture.runDirectory, "data", metadataBytes)
      updateArtifactDigest(fixture.runDirectory, "metadata", dataBytes)

      // When: each generated protobuf type is decoded at its declared side.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: swapped content is invalid evidence.
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("marks later operator evolution as an unproved publisher claim", () => {
    // Given: latest operator names preserve the immutable first operator and add one.
    const fixture = createVerifierFixture()
    try {
      const manifest = readVerifierJson(
          fixture.runDirectory,
          RunEvidencePath.Manifest
        ),
        artifact = recordValue(arrayField(manifest, "artifacts")[0])
      artifact["lastAcceptedObservationOrdinal"] = "2"
      artifact["lastAcceptedBatchOpNames"] = ["batchop.a", "batchop.b"]
      writeVerifierJson(
        fixture.runDirectory,
        RunEvidencePath.Manifest,
        manifest
      )

      // When: immutable bytes and structural monotonic claims are verified.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: the run remains valid while the limitation is explicit and non-saturating.
      expect(report.valid).toBe(true)
      expect(report.publisherClaims[0]?.lastAcceptedBatchOpNames).toEqual([
        "batchop.a",
        "batchop.b"
      ])
      expect(report.limitations[0]).toContain("publisher claims")
    } finally {
      fixture.cleanup()
    }
  })

})

function artifactSide(runDirectory: string, side: "data" | "metadata") {
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    artifact = recordValue(arrayField(manifest, "artifacts")[0]),
    refs = objectField(artifact, "firstImmutableRefs")
  return objectField(refs, side)
}

function updateArtifactDigest(
  runDirectory: string,
  side: "data" | "metadata",
  bytes: Uint8Array
): void {
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    artifact = recordValue(arrayField(manifest, "artifacts")[0]),
    refs = objectField(artifact, "firstImmutableRefs"),
    ref = objectField(refs, side)
  ref["sha256"] = verifierFixtureSha256(bytes)
  writeVerifierJson(runDirectory, RunEvidencePath.Manifest, manifest)
}
