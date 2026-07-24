import {
  EnvelopeIntegrityIssueCode,
  type EnvelopeIntegrityFileIdentity,
  type EnvelopeIntegrityResult
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  MaxEnvelopeBytes,
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  projectOppEnvelopeSaturationMetrics
} from "@wireio/test-opp-stress"

const FileIdentity: EnvelopeIntegrityFileIdentity = {
  dev: "1",
  ino: "2",
  mode: "16877",
  nlink: "2",
  size: "4096",
  mtimeNs: "3",
  ctimeNs: "4"
}

describe("strict envelope metric projection", () => {
  it("projects a root change into exact empty health", () => {
    // Given: a strict reader result that failed global root revalidation.
    const result: EnvelopeIntegrityResult = {
      kind: "scan_failed",
      candidates: ["discarded-candidate"],
      valid: [],
      pending: [],
      issues: [
        {
          code: EnvelopeIntegrityIssueCode.StorageRootChanged,
          baseKey: "$storage",
          context: {
            path: "/tmp/opp-debugging",
            before: FileIdentity,
            after: null,
            error: null
          }
        }
      ]
    }

    // When: the confirmed snapshot is projected into saturation metrics.
    const metrics = projectOppEnvelopeSaturationMetrics(result)

    // Then: all candidate and byte accounting is discarded with the exact issue retained.
    expect(metrics).toMatchObject({
      saturated: false,
      envelopeCount: 0,
      health: {
        kind: OppEnvelopeTelemetryHealthKind.Empty,
        candidateCount: 0,
        validCount: 0,
        filteredCount: 0,
        issueCount: 1,
        issues: [
          {
            code: OppEnvelopeTelemetryIssueCode.StorageRootChanged,
            baseKey: "$storage",
            context: {
              path: "/tmp/opp-debugging",
              before: FileIdentity,
              after: null,
              error: null
            }
          }
        ]
      }
    })
  })

  it("keeps valid diagnostics but denies credit for a candidate read failure", () => {
    // Given: one validated near-cap pair and one exact candidate read issue.
    const validBaseKey = "00000007-OUTPOST_ETHEREUM_DEPOT-0123456789abcdef",
      invalidBaseKey = "00000007-OUTPOST_ETHEREUM_DEPOT-fedcba9876543210",
      result: EnvelopeIntegrityResult = {
        kind: "collected",
        candidates: [validBaseKey, invalidBaseKey],
        valid: [
          {
            baseKey: validBaseKey,
            epochIndex: 7,
            endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
            checksum: "0123456789abcdef",
            epochEnvelopeIndex: 0,
            dataBytes: new Uint8Array(MaxEnvelopeBytes),
            metadataBytes: new Uint8Array(),
            dataSha256: "0".repeat(64),
            dataMtimeNs: "100",
            metadataMtimeNs: "101",
            metadataChecksum: "0123456789ab",
            batchOpNames: ["batchop.a"]
          }
        ],
        pending: [],
        issues: [
          {
            code: EnvelopeIntegrityIssueCode.DataReadFailed,
            baseKey: invalidBaseKey,
            context: {
              path: `/tmp/${invalidBaseKey}.data`,
              error: {
                name: "Error",
                code: "EIO",
                message: "input/output failure",
                operation: "read"
              }
            }
          }
        ]
      }

    // When: byte-threshold projection is requested.
    const metrics = projectOppEnvelopeSaturationMetrics(result, {
      saturationStrategy: "byte_threshold"
    })

    // Then: valid bytes remain diagnostic while pending health forces saturation false.
    expect(metrics).toMatchObject({
      saturated: false,
      envelopeCount: 1,
      byteSizes: [MaxEnvelopeBytes],
      health: {
        kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
        candidateCount: 2,
        validCount: 1,
        filteredCount: 0,
        issueCount: 1,
        issues: [
          {
            code: OppEnvelopeTelemetryIssueCode.DataReadFailed,
            baseKey: invalidBaseKey,
            context: {
              error: { code: "EIO", operation: "read" }
            }
          }
        ]
      }
    })
    expect(metrics.health.kind).not.toBe(
      OppEnvelopeTelemetryHealthKind.Degraded
    )
  })
})
