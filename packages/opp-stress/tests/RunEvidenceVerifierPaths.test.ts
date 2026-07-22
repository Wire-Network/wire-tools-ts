import {
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  arrayField,
  createVerifierFixture,
  readVerifierJson,
  recordValue,
  refreshVerifierRecordHash,
  writeVerifierJson
} from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier reference paths", () => {
  it.each([
    "../escape.data",
    "artifacts\\opp\\escape.data",
    "/tmp/absolute.data"
  ])("rejects unsafe run-relative ref %s", unsafeRef => {
    // Given: a phase contains a traversal, backslash, or absolute artifact ref.
    const fixture = createVerifierFixture()
    try {
      const iterationPath = `${RunEvidencePath.Iterations}/000000.json`,
        iteration = readVerifierJson(fixture.runDirectory, iterationPath),
        phase = recordValue(arrayField(iteration, "phases")[0])
      phase["artifactRefs"] = [unsafeRef]
      writeVerifierJson(fixture.runDirectory, iterationPath, iteration)
      refreshVerifierRecordHash(fixture.runDirectory, iterationPath)

      // When: schema paths are parsed before filesystem resolution.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: unsafe references are typed invalid evidence and never opened.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.InvalidIteration
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects duplicate phase refs", () => {
    // Given: one valid data ref is repeated in a phase.
    const fixture = createVerifierFixture()
    try {
      const path = `${RunEvidencePath.Iterations}/000000.json`,
        iteration = readVerifierJson(fixture.runDirectory, path),
        phase = recordValue(arrayField(iteration, "phases")[0]),
        refs = arrayField(phase, "artifactRefs")
      phase["artifactRefs"] = [refs[0], refs[0]]
      writeVerifierJson(fixture.runDirectory, path, iteration)
      refreshVerifierRecordHash(fixture.runDirectory, path)

      // When: exact artifact-ref uniqueness is parsed.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: duplicate selected refs invalidate the iteration record.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.InvalidIteration
      )
    } finally {
      fixture.cleanup()
    }
  })
})
