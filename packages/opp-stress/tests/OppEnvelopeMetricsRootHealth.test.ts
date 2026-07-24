import * as Fs from "node:fs"

import {
  collectOppEnvelopeSaturationMetrics,
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode
} from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  removeMetricStorageDir,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"

describe("strict OPP envelope root health", () => {
  let storageDir: string

  beforeEach(() => {
    storageDir = makeMetricStorageDir("root-health")
  })

  afterEach(() => {
    removeMetricStorageDir(storageDir)
  })

  it("returns empty health for a missing storage root", async () => {
    // Given: the requested storage directory no longer exists.
    removeMetricStorageDir(storageDir)

    // When: strict envelope metrics are collected.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir)

    // Then: the root failure is exact, global, and receives no credit.
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
            code: OppEnvelopeTelemetryIssueCode.StorageRootReadFailed,
            baseKey: "$storage",
            context: {
              path: storageDir,
              error: { code: "ENOENT", operation: "root_lstat" }
            }
          }
        ]
      }
    })
  })

  it("returns empty health when the storage root is not a directory", async () => {
    // Given: the storage-root path resolves to a regular file.
    removeMetricStorageDir(storageDir)
    Fs.writeFileSync(storageDir, "not a directory")

    // When: strict envelope metrics are collected.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir)

    // Then: the exact root classification is retained without candidates.
    expect(metrics.health).toMatchObject({
      kind: OppEnvelopeTelemetryHealthKind.Empty,
      issueCount: 1,
      issues: [
        {
          code: OppEnvelopeTelemetryIssueCode.StorageRootNotDirectory,
          baseKey: "$storage",
          context: { path: storageDir }
        }
      ]
    })
  })

  it("returns issue-free empty health for an empty directory", async () => {
    // Given: an existing storage directory with no candidate sidecars.

    // When: strict envelope metrics are collected.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir)

    // Then: the observation is retryable empty rather than healthy.
    expect(metrics.health).toEqual({
      kind: OppEnvelopeTelemetryHealthKind.Empty,
      retryable: true,
      candidateCount: 0,
      validCount: 0,
      filteredCount: 0,
      issueCount: 0,
      issues: []
    })
    expect(metrics.saturated).toBe(false)
  })

  it("accounts for both orphan directions as pending publication", async () => {
    // Given: one data-only and one metadata-only canonical candidate.
    const dataOnly = writeMetricEnvelopeFixture(storageDir, 0),
      metadataOnly = writeMetricEnvelopeFixture(storageDir, 1)
    Fs.rmSync(dataOnly.metadataPath)
    Fs.rmSync(metadataOnly.dataPath)

    // When: strict envelope metrics are collected.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir)

    // Then: both candidates and exact missing-sidecar contexts remain visible.
    expect(metrics.health).toMatchObject({
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      candidateCount: 2,
      validCount: 0,
      filteredCount: 0,
      issueCount: 2
    })
    expect(metrics.health.issues).toEqual(
      [
        {
          code: OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar,
          baseKey: dataOnly.baseKey,
          context: { path: dataOnly.metadataPath }
        },
        {
          code: OppEnvelopeTelemetryIssueCode.MissingDataSidecar,
          baseKey: metadataOnly.baseKey,
          context: { path: metadataOnly.dataPath }
        }
      ].sort(compareIssueBaseKeys)
    )
    expect(metrics.saturated).toBe(false)
  })
})

function compareIssueBaseKeys(
  left: { readonly baseKey: string },
  right: { readonly baseKey: string }
): number {
  return left.baseKey < right.baseKey
    ? -1
    : left.baseKey > right.baseKey
      ? 1
      : 0
}
