import * as Fs from "node:fs"

import {
  collectOppEnvelopeSaturationMetrics,
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode
} from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  removeMetricStorageDir,
  writeInvalidMetricPair,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"

describe("strict OPP envelope candidate accounting", () => {
  it("keeps an all-invalid snapshot pending with exact candidate counts", async () => {
    // Given: one malformed key and one canonical pair with invalid data bytes.
    const storageDir = makeMetricStorageDir("all-invalid")
    writeInvalidMetricPair(storageDir, "bad")
    const corruptPair = writeMetricEnvelopeFixture(storageDir, 0)
    Fs.writeFileSync(corruptPair.dataPath, Buffer.from([0xff]))

    // When: strict envelope metrics are collected.
    const metrics = await collectOppEnvelopeSaturationMetrics(storageDir)
    removeMetricStorageDir(storageDir)

    // Then: neither invalid candidate is counted as valid, filtered, or saturated.
    expect(metrics).toMatchObject({ envelopeCount: 0, saturated: false })
    expect(metrics.health).toMatchObject({
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      retryable: true,
      candidateCount: 2,
      validCount: 0,
      filteredCount: 0,
      issueCount: 2
    })
    expect(metrics.health.issues.map(issue => issue.code).sort()).toEqual(
      [
        OppEnvelopeTelemetryIssueCode.InvalidStorageKey,
        OppEnvelopeTelemetryIssueCode.DataDecodeFailed
      ].sort()
    )
    expect(metrics.health.kind).not.toBe(
      OppEnvelopeTelemetryHealthKind.Degraded
    )
  })
})
