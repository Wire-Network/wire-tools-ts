import * as Fs from "node:fs"
import * as Path from "node:path"

import { DebugEnvelopeMetadataRecord } from "@wireio/opp-typescript-models"
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
  refreshVerifierRecordHash,
  stringField,
  writeVerifierJson
} from "./runEvidenceVerifierTestSupport.js"
import {
  duplicateFieldSaturationExploitBytes,
  DuplicateMetadataChecksumFieldNumber,
  prependDuplicateKnownField
} from "./duplicateProtobufFieldTestSupport.js"
import {
  appendUnknownLengthDelimitedField,
  unknownFieldSaturationExploitBytes
} from "./unknownProtobufFieldTestSupport.js"

describe("run evidence verifier unknown protobuf fields", () => {
  it("rejects a hash-consistent duplicate-known-field saturation artifact", () => {
    // Given: a duplicate of singular field 1 inflates canonical bytes while key,
    // metadata, and manifest hashes all agree on the padded content.
    const fixture = createVerifierFixture()
    try {
      replaceArtifactWithExploit(
        fixture.runDirectory,
        duplicateFieldSaturationExploitBytes(1)
      )

      // When: the offline verifier independently decodes the hash-consistent bytes.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: padded data is invalid under the existing decode-failure category.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.DataDecodeFailed
      )
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects hash-consistent metadata repeating its singular checksum field", () => {
    // Given: immutable metadata repeats field 1 and its manifest hash is refreshed.
    const fixture = createVerifierFixture()
    try {
      const manifest = readVerifierJson(
          fixture.runDirectory,
          RunEvidencePath.Manifest
        ),
        artifact = recordValue(arrayField(manifest, "artifacts")[0]),
        refs = objectField(artifact, "firstImmutableRefs"),
        metadataRef = objectField(refs, "metadata"),
        metadataFile = Path.join(
          fixture.runDirectory,
          stringField(metadataRef, "path")
        ),
        metadataBytes = prependDuplicateKnownField(
          Fs.readFileSync(metadataFile),
          DuplicateMetadataChecksumFieldNumber,
          1
        )
      Fs.writeFileSync(metadataFile, metadataBytes)
      metadataRef["sha256"] = verifierFixtureSha256(metadataBytes)
      writeVerifierJson(fixture.runDirectory, RunEvidencePath.Manifest, manifest)

      // When: the offline verifier decodes the hash-consistent metadata bytes.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: repeated singular metadata fields are rejected like unknown fields.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.MetadataDecodeFailed
      )
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects a hash-consistent unknown-field saturation artifact", () => {
    // Given: field 500 inflates canonical bytes while key, metadata, and manifest hashes agree.
    const fixture = createVerifierFixture()
    try {
      replaceArtifactWithExploit(
        fixture.runDirectory,
        unknownFieldSaturationExploitBytes(1)
      )

      // When: the offline verifier independently decodes the hash-consistent bytes.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: unknown data is invalid under the existing decode-failure category.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.DataDecodeFailed
      )
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects hash-consistent metadata containing an unknown field", () => {
    // Given: immutable metadata gains field 500 and its full manifest hash is refreshed.
    const fixture = createVerifierFixture()
    try {
      const manifest = readVerifierJson(
          fixture.runDirectory,
          RunEvidencePath.Manifest
        ),
        artifact = recordValue(arrayField(manifest, "artifacts")[0]),
        refs = objectField(artifact, "firstImmutableRefs"),
        metadataRef = objectField(refs, "metadata"),
        metadataFile = Path.join(
          fixture.runDirectory,
          stringField(metadataRef, "path")
        ),
        metadataBytes = appendUnknownLengthDelimitedField(
          Fs.readFileSync(metadataFile),
          1
        )
      Fs.writeFileSync(metadataFile, metadataBytes)
      metadataRef["sha256"] = verifierFixtureSha256(metadataBytes)
      writeVerifierJson(fixture.runDirectory, RunEvidencePath.Manifest, manifest)

      // When: the offline verifier decodes the hash-consistent metadata bytes.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: unknown metadata is invalid under the existing decode-failure category.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.MetadataDecodeFailed
      )
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })
})

function replaceArtifactWithExploit(
  runDirectory: string,
  exploitBytes: Buffer
): void {
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    artifact = recordValue(arrayField(manifest, "artifacts")[0]),
    refs = objectField(artifact, "firstImmutableRefs"),
    dataRef = objectField(refs, "data"),
    metadataRef = objectField(refs, "metadata"),
    oldBaseKey = stringField(artifact, "baseKey"),
    oldDataPath = stringField(dataRef, "path"),
    oldMetadataPath = stringField(metadataRef, "path"),
    dataBytes = exploitBytes,
    dataSha256 = verifierFixtureSha256(dataBytes),
    baseKey = `00000001-DEPOT_OUTPOST_ETHEREUM-${dataSha256.slice(0, 16)}`,
    dataPath = oldDataPath.replace(oldBaseKey, baseKey),
    metadataPath = oldMetadataPath.replace(oldBaseKey, baseKey),
    metadataBytes = Buffer.from(
      DebugEnvelopeMetadataRecord.toBinary({
        checksum: BigInt(`0x${dataSha256.slice(0, 12)}`),
        batchOpNames: ["batchop.a"]
      })
    )
  Fs.writeFileSync(Path.join(runDirectory, dataPath), dataBytes)
  Fs.writeFileSync(Path.join(runDirectory, metadataPath), metadataBytes)
  Fs.rmSync(Path.join(runDirectory, oldDataPath))
  Fs.rmSync(Path.join(runDirectory, oldMetadataPath))
  artifact["baseKey"] = baseKey
  dataRef["path"] = dataPath
  dataRef["sha256"] = dataSha256
  metadataRef["path"] = metadataPath
  metadataRef["sha256"] = verifierFixtureSha256(metadataBytes)
  writeVerifierJson(runDirectory, RunEvidencePath.Manifest, manifest)
  replaceRecordBaseKey(
    runDirectory,
    `${RunEvidencePath.Iterations}/000000.json`,
    oldBaseKey,
    baseKey
  )
  replaceRecordBaseKey(
    runDirectory,
    RunEvidencePath.Terminal,
    oldBaseKey,
    baseKey
  )
}

function replaceRecordBaseKey(
  runDirectory: string,
  relativePath: string,
  oldBaseKey: string,
  baseKey: string
): void {
  const record: unknown = JSON.parse(
    Fs.readFileSync(Path.join(runDirectory, relativePath), "utf8").replaceAll(
      oldBaseKey,
      baseKey
    )
  )
  writeVerifierJson(runDirectory, relativePath, record)
  refreshVerifierRecordHash(runDirectory, relativePath)
}
