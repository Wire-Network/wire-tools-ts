import {
  RunEvidenceEndpoint,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  forgePhaseEndpoint,
  mutateVerifierFirstPhase
} from "./runEvidenceVerifierMutationSupport.js"
import { createVerifierFixture } from "./runEvidenceVerifierTestSupport.js"

describe("run evidence verifier phase endpoint authority", () => {
  it("rejects a hash-consistent forged phase endpoint without saturation credit", () => {
    // Given: canonical raw Ethereum evidence and internally consistent record hashes.
    const fixture = createVerifierFixture()
    try {
      mutateVerifierFirstPhase(fixture.runDirectory, phase =>
        forgePhaseEndpoint(phase, RunEvidenceEndpoint.DepotOutpostSolana)
      )

      // When: the verifier recomputes endpoint membership from immutable bytes.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: phase authority is rejected independently of required-endpoint claims.
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: RunEvidenceVerificationIssueCode.MetricMismatch,
          detail: expect.stringContaining("selected out-of-filter artifact")
        })
      )
    } finally {
      fixture.cleanup()
    }
  })
})
