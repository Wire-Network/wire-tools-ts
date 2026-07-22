import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceSaturationStrategy,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence,
  type OppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"

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

const OmittedCandidateIssue = {
  code: OppEnvelopeTelemetryIssueCode.DataDecodeFailed,
  baseKey: "00000002-DEPOT_OUTPOST_ETHEREUM-deadbeefdeadbeef",
  context: {
    path: "artifacts/opp/omitted.data",
    reason: "invalid envelope bytes"
  }
} as const

const BreakageTelemetries: readonly OppEnvelopeTelemetryHealth[] = [
  {
    kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
    retryable: true,
    candidateCount: 2,
    validCount: 1,
    filteredCount: 0,
    issueCount: 1,
    issues: [OmittedCandidateIssue]
  },
  {
    kind: OppEnvelopeTelemetryHealthKind.Degraded,
    retryable: false,
    candidateCount: 2,
    validCount: 1,
    filteredCount: 0,
    issueCount: 1,
    issues: [OmittedCandidateIssue]
  }
]

describe("run evidence verifier persisted telemetry accounting", () => {
  it.each(BreakageTelemetries)(
    "accepts legitimate $kind breakage evidence",
    telemetry => {
      // Given: one retained valid pair and one unretained invalid candidate issue.
      const fixture = createVerifierFixture({
        lifecycle: RunEvidenceLifecycle.Failed,
        breakagePhaseTelemetry: telemetry
      })
      try {
        // When: persisted accounting is checked against retained immutable bytes.
        const report = verifyRunEvidence(fixture.runDirectory)

        // Then: an honest failed observation is valid but never saturation evidence.
        expect(report.issues).toEqual([])
        expect(report.verifiedSaturated).toBe(false)
        expect(report.recomputedIterations[0]?.phases[0]?.saturated).toBe(false)
      } finally {
        fixture.cleanup()
      }
    }
  )

  it("accepts filtered valid candidate accounting without selected filtered refs", () => {
    // Given: one selected valid pair and one publisher-recorded filtered candidate.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.Incomplete,
      phases: [
        {
          endpoint: RunEvidenceEndpoint.DepotOutpostEthereum,
          strategy: RunEvidenceSaturationStrategy.ByteThreshold,
          byteSize: 62_258,
          epochEnvelopeIndex: 0,
          telemetry: {
            kind: OppEnvelopeTelemetryHealthKind.Healthy,
            retryable: false,
            candidateCount: 2,
            validCount: 1,
            filteredCount: 1,
            issueCount: 0,
            issues: []
          }
        }
      ]
    })
    try {
      // When: selected bytes and persisted candidate accounting are verified.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: filteredCount is a publisher claim, not a selected artifact pair.
      expect(report.issues).toEqual([])
      expect(report.limitations.join(" ")).toContain("filtered")
    } finally {
      fixture.cleanup()
    }
  })

  it("withholds saturation credit from a breakage phase with saturating raw bytes", () => {
    // Given: one threshold-sized raw pair is retained by honest breakage evidence.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.Failed,
      phases: [
        {
          endpoint: RunEvidenceEndpoint.DepotOutpostEthereum,
          strategy: RunEvidenceSaturationStrategy.ByteThreshold,
          byteSize: 62_259,
          epochEnvelopeIndex: 0
        }
      ],
      breakagePhaseTelemetry: {
        kind: OppEnvelopeTelemetryHealthKind.Healthy,
        retryable: false,
        candidateCount: 1,
        validCount: 1,
        filteredCount: 0,
        issueCount: 0,
        issues: []
      }
    })
    try {
      const report = verifyRunEvidence(fixture.runDirectory)

      // When/Then: retained bytes remain measurable without earning success credit.
      expect(report.issues).toEqual([])
      expect(report.recomputedIterations[0]?.phases[0]?.saturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects duplicate candidate issues for one strict-reader outcome", () => {
    // Given: one omitted candidate is represented by two issues with the same base key.
    const telemetry: OppEnvelopeTelemetryHealth = {
        kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
        retryable: true,
        candidateCount: 2,
        validCount: 1,
        filteredCount: 0,
        issueCount: 2,
        issues: [OmittedCandidateIssue, OmittedCandidateIssue]
      },
      fixture = createVerifierFixture({
        lifecycle: RunEvidenceLifecycle.Failed,
        breakagePhaseTelemetry: telemetry
      })
    try {
      // When: candidate accounting is compared with selected immutable pairs.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: duplicate issue partitions are impossible strict-reader evidence.
      expect(report.valid).toBe(false)
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.TelemetryMismatch
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects an issue key that overlaps a selected valid artifact", () => {
    // Given: one parser-valid candidate issue is rewritten to the selected pair key.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.Failed,
      breakagePhaseTelemetry: BreakageTelemetries[0]
    })
    try {
      const manifest = readVerifierJson(
          fixture.runDirectory,
          RunEvidencePath.Manifest
        ),
        artifact = recordValue(arrayField(manifest, "artifacts")[0]),
        selectedBaseKey = stringField(artifact, "baseKey")
      mutatePhaseTelemetry(fixture.runDirectory, telemetry => {
        recordValue(arrayField(telemetry, "issues")[0])["baseKey"] =
          selectedBaseKey
      })

      // When: the selected and issue candidate partitions are compared.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: one strict-reader candidate cannot be both valid and invalid.
      expect(report.valid).toBe(false)
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.TelemetryMismatch
      )
    } finally {
      fixture.cleanup()
    }
  })
})

function mutatePhaseTelemetry(
  runDirectory: string,
  mutate: (telemetry: Record<string, unknown>) => void
): void {
  const iterationPath = `${RunEvidencePath.Iterations}/000000.json`,
    iteration = readVerifierJson(runDirectory, iterationPath),
    phase = recordValue(arrayField(iteration, "phases")[0])
  mutate(objectField(phase, "telemetry"))
  writeVerifierJson(runDirectory, iterationPath, iteration)
  refreshVerifierRecordHash(runDirectory, iterationPath)
  const manifest = readVerifierJson(runDirectory, RunEvidencePath.Manifest),
    refs = arrayField(objectField(manifest, "records"), "iterations"),
    terminal = readVerifierJson(runDirectory, RunEvidencePath.Terminal)
  terminal["iterationRefs"] = refs
  writeVerifierJson(runDirectory, RunEvidencePath.Terminal, terminal)
  refreshVerifierRecordHash(runDirectory, RunEvidencePath.Terminal)
}
