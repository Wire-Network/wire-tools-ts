import {
  RunEvidenceLifecycle,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { createVerifierFixture } from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier lifecycle matrix", () => {
  it.each([
    [
      RunEvidenceLifecycle.Initializing,
      RunEvidenceVerificationVerdict.InProgress
    ],
    [RunEvidenceLifecycle.Running, RunEvidenceVerificationVerdict.InProgress],
    [
      RunEvidenceLifecycle.SetupFailed,
      RunEvidenceVerificationVerdict.NonSuccess
    ],
    [RunEvidenceLifecycle.Failed, RunEvidenceVerificationVerdict.NonSuccess],
    [
      RunEvidenceLifecycle.Incomplete,
      RunEvidenceVerificationVerdict.NonSuccess
    ],
    [RunEvidenceLifecycle.Saturated, RunEvidenceVerificationVerdict.Saturated]
  ])("verifies %s evidence as %s", (lifecycle, verdict) => {
    // Given: canonical evidence for one lifecycle state.
    const fixture = createVerifierFixture({ lifecycle })
    try {
      // When: the offline verifier reads the explicit run directory.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: valid state is distinguished from successful saturation.
      expect(report.issues).toEqual([])
      expect(report.valid).toBe(true)
      expect(report.verdict).toBe(verdict)
      expect(report.verifiedSaturated).toBe(
        lifecycle === RunEvidenceLifecycle.Saturated
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("verifies setup failure after cluster config capture", () => {
    // Given: setup failed only after a config snapshot was committed.
    const fixture = createVerifierFixture({
      lifecycle: RunEvidenceLifecycle.SetupFailed,
      configCreatedBeforeSetupFailure: true
    })
    try {
      // When: the completed non-success evidence is verified.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: captured config remains valid but never becomes success.
      expect(report.valid).toBe(true)
      expect(report.verdict).toBe(RunEvidenceVerificationVerdict.NonSuccess)
    } finally {
      fixture.cleanup()
    }
  })
})
