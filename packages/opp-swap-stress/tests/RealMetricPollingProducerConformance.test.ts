import { validateEnvelopeStorageKey } from "@wireio/debugging-shared"
import {
  OppEnvelopeTelemetryIssueCode,
  type OppEnvelopeTelemetryIssue
} from "@wireio/test-opp-stress"

import { producePollableIntegrityIssues } from "./realMetricPollingIssueFixtures.js"

describe("real metric polling producer conformance", () => {
  it("produces every post-baseline code through canonical strict-reader paths", async () => {
    // Given: every fixture is captured from readEnvelopeIntegrity and mapped in production.
    const fixtures = await producePollableIntegrityIssues(),
      issues = fixtures.map(fixture => fixture.issue),
      issue = issueLookup(issues)

    // When/Then: the producer-backed set is complete and unique.
    expect(issues.map(value => value.code).sort()).toEqual(
      Object.values(OppEnvelopeTelemetryIssueCode)
        .filter(
          code => code !== OppEnvelopeTelemetryIssueCode.BaselineCaptureFailed
        )
        .sort()
    )
    expect(new Set(issues.map(value => value.code)).size).toBe(24)
    expect(
      issues
        .filter(value => value.baseKey !== "$storage")
        .filter(
          value =>
            value.code !== OppEnvelopeTelemetryIssueCode.InvalidStorageKey &&
            value.code !== OppEnvelopeTelemetryIssueCode.UnknownEndpoint &&
            value.code !== OppEnvelopeTelemetryIssueCode.PathOutsideStorageRoot
        )
        .every(value => validateEnvelopeStorageKey(value.baseKey).kind === "valid")
    ).toBe(true)
    expect(issue(OppEnvelopeTelemetryIssueCode.UnknownEndpoint)).toMatchObject({
      baseKey: "00000007-UNKNOWN-0123456789abcdef",
      context: { endpointKey: "UNKNOWN" }
    })
    expect(issue(OppEnvelopeTelemetryIssueCode.PathOutsideStorageRoot)).toMatchObject({
      baseKey: "../escape",
      context: { path: expect.stringMatching(/escape\.data$/) }
    })
    ;[
      OppEnvelopeTelemetryIssueCode.DataSidecarSymlink,
      OppEnvelopeTelemetryIssueCode.MetadataSidecarSymlink
    ].forEach(code =>
      expect(issue(code)).toMatchObject({
        context: { error: { code: "ELOOP", operation: "open" } }
      })
    )
    expect(issue(OppEnvelopeTelemetryIssueCode.MissingDataSidecar)).toMatchObject({
      context: { path: expect.stringMatching(/\.data$/) }
    })
    expect(
      issue(OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar)
    ).toMatchObject({ context: { path: expect.stringMatching(/\.metadata$/) } })
    expect(
      issue(OppEnvelopeTelemetryIssueCode.DataSidecarNotRegular)
    ).toMatchObject({ context: { path: expect.stringMatching(/\.data$/) } })
    expect(
      issue(OppEnvelopeTelemetryIssueCode.MetadataSidecarNotRegular)
    ).toMatchObject({ context: { path: expect.stringMatching(/\.metadata$/) } })
    ;[
      OppEnvelopeTelemetryIssueCode.DataReadFailed,
      OppEnvelopeTelemetryIssueCode.MetadataReadFailed
    ].forEach(code =>
      expect(issue(code)).toMatchObject({
        context: { error: { code: "EIO", operation: "read" } }
      })
    )
    ;[
      OppEnvelopeTelemetryIssueCode.DataDecodeFailed,
      OppEnvelopeTelemetryIssueCode.MetadataDecodeFailed
    ].forEach(code =>
      expect(issue(code)).toMatchObject({ context: { reason: "premature EOF" } })
    )
    expect(issue(OppEnvelopeTelemetryIssueCode.DataHashMismatch)).toMatchObject({
      context: {
        expectedHashPrefix: "0000000000000000",
        actualHashPrefix: expect.stringMatching(/^[0-9a-f]{16}$/),
        actualSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    })
    ;[
      OppEnvelopeTelemetryIssueCode.DataSidecarChanged,
      OppEnvelopeTelemetryIssueCode.MetadataSidecarChanged
    ].forEach(code =>
      expect(issue(code)).toMatchObject({
        context: { error: { code: "EIO", operation: "verify_open" } }
      })
    )
    expect(
      issue(OppEnvelopeTelemetryIssueCode.MetadataChecksumMismatch)
    ).toMatchObject({ context: { actualChecksum: "000000000002" } })
    expect(issue(OppEnvelopeTelemetryIssueCode.EpochMismatch)).toMatchObject({
      context: { keyEpoch: 7, decodedEpoch: 8 }
    })
    expect(issue(OppEnvelopeTelemetryIssueCode.StorageRootReadFailed)).toMatchObject({
      baseKey: "$storage",
      context: { error: { code: "EIO", operation: "root_lstat" } }
    })
    expect(issue(OppEnvelopeTelemetryIssueCode.DirectoryScanFailed)).toMatchObject({
      baseKey: "$storage",
      context: { error: { code: "EIO", operation: "readdir" } }
    })
    expect(issue(OppEnvelopeTelemetryIssueCode.StorageRootChanged)).toMatchObject({
      baseKey: "$storage",
      context: { error: null }
    })
    ;[
      OppEnvelopeTelemetryIssueCode.StorageRootSymlink,
      OppEnvelopeTelemetryIssueCode.StorageAncestorSymlink,
      OppEnvelopeTelemetryIssueCode.StorageRootNotDirectory
    ].forEach(code =>
      expect(issue(code)).toMatchObject({
        baseKey: "$storage",
        context: { path: expect.stringContaining("polling-") }
      })
    )
  })
})

function issueLookup(
  issues: readonly OppEnvelopeTelemetryIssue[]
): (code: OppEnvelopeTelemetryIssueCode) => OppEnvelopeTelemetryIssue {
  return code => {
    const issue = issues.find(value => value.code === code)
    if (issue === undefined) throw new TypeError(`missing producer issue ${code}`)
    return issue
  }
}
