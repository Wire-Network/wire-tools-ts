import * as Path from "node:path"

import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import {
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  arrayField,
  createVerifierFixture,
  objectField,
  stringField
} from "./runEvidenceVerifierTestSupport.js"
import { mutateVerifierFirstPhase } from "./runEvidenceVerifierMutationSupport.js"

describe("run evidence verifier baseline membership", () => {
  it("rejects selected base-key overlap when baseline artifact refs are empty", () => {
    // Given: persisted baseline membership contains the selected pair's base key.
    const fixture = createVerifierFixture()
    try {
      mutateVerifierFirstPhase(fixture.runDirectory, phase => {
        const selectedDataRef = stringField(
            { selected: arrayField(phase, "artifactRefs")[0] },
            "selected"
          ),
          baseline = objectField(phase, "baseline"),
          canonical = createEnvelopeBaseline([
            Path.basename(selectedDataRef, ".data")
          ])
        baseline["identity"] = canonical.identity
        baseline["baseKeys"] = canonical.baseKeys
        baseline["artifactRefs"] = []
      })

      // When: the verifier checks membership from persisted keys, not refs.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: selected evidence that predates the phase is invalid.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.ArtifactRefOverlap
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("accepts a selected artifact absent from persisted baseline keys", () => {
    // Given: a hash-consistent empty baseline key set and one selected pair.
    const fixture = createVerifierFixture()
    try {
      mutateVerifierFirstPhase(fixture.runDirectory, phase => {
        const baseline = objectField(phase, "baseline"),
          canonical = createEnvelopeBaseline([])
        baseline["identity"] = canonical.identity
        baseline["baseKeys"] = canonical.baseKeys
        baseline["artifactRefs"] = []
      })

      // When: the offline verifier independently recomputes phase evidence.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: non-overlapping selected evidence remains valid saturation proof.
      expect(report.valid).toBe(true)
      expect(report.verifiedSaturated).toBe(true)
    } finally {
      fixture.cleanup()
    }
  })
})
