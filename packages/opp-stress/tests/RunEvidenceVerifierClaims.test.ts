import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  arrayField,
  createVerifierFixture,
  objectField,
  readVerifierJson,
  refreshVerifierRecordHash,
  writeVerifierJson
} from "./runEvidenceVerifierTestSupport.js"
import {
  mutateVerifierFirstPhase,
  mutateVerifierIteration
} from "./runEvidenceVerifierMutationSupport.js"

describe("run evidence verifier recorded-claim comparisons", () => {
  it.each([
    [
      "count",
      (phase: Record<string, unknown>) => {
        const metrics = objectField(phase, "metrics")
        metrics["envelopeCount"] = 2
        metrics["envelopeByteSizes"] = [62_259, 62_259]
        metrics["epochEnvelopeIndexes"] = [0, 0]
      }
    ],
    [
      "byte size",
      (phase: Record<string, unknown>) => {
        objectField(phase, "metrics")["envelopeByteSizes"] = [62_260]
      }
    ],
    [
      "envelope index",
      (phase: Record<string, unknown>) => {
        objectField(phase, "metrics")["epochEnvelopeIndexes"] = [1]
      }
    ],
    [
      "Solana flag",
      (phase: Record<string, unknown>) => {
        objectField(phase, "metrics")["solanaOversized"] = true
      }
    ],
    [
      "strategy",
      (phase: Record<string, unknown>) => {
        phase["strategy"] = "rollover"
      }
    ],
    [
      "epoch window",
      (phase: Record<string, unknown>) => {
        const window = objectField(phase, "window")
        window["epochStart"] = "2"
        window["epochEnd"] = "2"
      }
    ]
  ])(
    "rejects a forged %s target with refreshed record hashes",
    (_label, mutate) => {
      // Given: structurally valid recorded metrics are changed without changing raw bytes.
      const fixture = createVerifierFixture()
      try {
        mutateVerifierFirstPhase(fixture.runDirectory, mutate)

        // When: iteration hashes match the forged record.
        const report = verifyRunEvidence(fixture.runDirectory)

        // Then: independent metric projection still detects the disagreement.
        expect(report.valid).toBe(false)
        expect(report.verifiedSaturated).toBe(false)
        expect(report.issues.map(issue => issue.code)).toContain(
          RunEvidenceVerificationIssueCode.MetricMismatch
        )
      } finally {
        fixture.cleanup()
      }
    }
  )

  it("rejects forged account-ramp and exact-max claims", () => {
    // Given: a valid saturated iteration records a noncanonical first account count.
    const fixture = createVerifierFixture()
    try {
      mutateVerifierIteration(fixture.runDirectory, iteration => {
        iteration["accountCount"] = 4
      })

      // When: controller progression is recomputed from manifest config.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: account count is never trusted as a controller claim.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.AccountRampMismatch
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects baseline overlap", () => {
    // Given: selected refs also appear in the pre-phase baseline.
    const fixture = createVerifierFixture()
    try {
      mutateVerifierFirstPhase(fixture.runDirectory, phase => {
        const selected = arrayField(phase, "artifactRefs"),
          baseline = objectField(phase, "baseline")
        baseline["artifactRefs"] = [...selected]
      })

      // When: declared phase membership is resolved into complete pairs.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: baseline membership cannot be reused as selected evidence.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.ArtifactRefOverlap
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects a selected pair outside the phase epoch filter", () => {
    // Given: immutable refs select an epoch-one pair under an epoch-two window.
    const fixture = createVerifierFixture()
    try {
      mutateVerifierFirstPhase(fixture.runDirectory, phase => {
        const window = objectField(phase, "window")
        window["epochStart"] = "2"
        window["epochEnd"] = "2"
      })

      // When: selected pair membership is checked before metric projection.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: selected refs cannot be silently reclassified as filtered candidates.
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

  it("rejects half artifact pairs", () => {
    // Given: a phase selects data without its metadata pair.
    const fixture = createVerifierFixture()
    try {
      mutateVerifierFirstPhase(fixture.runDirectory, phase => {
        const selected = arrayField(phase, "artifactRefs")
        phase["artifactRefs"] = [selected[0]]
      })

      // When: selected membership is resolved by canonical base key.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: incomplete pair membership is rejected.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.IncompleteArtifactPair
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects relative provenance and unavailable config after setup", () => {
    // Given: manifest boundary claims violate absolute provenance and config lifecycle.
    const fixture = createVerifierFixture()
    try {
      const manifest = readVerifierJson(
        fixture.runDirectory,
        RunEvidencePath.Manifest
      )
      objectField(manifest, "provenance")["wireBuildPath"] = "relative/build"
      manifest["clusterConfigSnapshot"] = {
        kind: "unavailable",
        reason: "cluster_config_not_created"
      }
      writeVerifierJson(
        fixture.runDirectory,
        RunEvidencePath.Manifest,
        manifest
      )

      // When: the manifest and provenance parsers run at the disk boundary.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: structurally impossible lifecycle evidence is invalid.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.InvalidManifest
      )
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects terminal preservation and reference contradictions", () => {
    // Given: saturated terminal claims preservation and drops its iteration refs.
    const fixture = createVerifierFixture()
    try {
      const terminal = readVerifierJson(
        fixture.runDirectory,
        RunEvidencePath.Terminal
      )
      terminal["preserveCluster"] = true
      terminal["iterationRefs"] = []
      writeVerifierJson(
        fixture.runDirectory,
        RunEvidencePath.Terminal,
        terminal
      )
      refreshVerifierRecordHash(fixture.runDirectory, RunEvidencePath.Terminal)

      // When: terminal parser and manifest agreement are verified.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: status/preservation/reference claims cannot form success.
      expect(report.valid).toBe(false)
      expect(report.verifiedSaturated).toBe(false)
    } finally {
      fixture.cleanup()
    }
  })

  it("rejects noncanonical JSON despite equivalent parsed values", () => {
    // Given: canonical manifest is rewritten as pretty JSON with no content change.
    const fixture = createVerifierFixture()
    try {
      const manifestFile = Path.join(
          fixture.runDirectory,
          RunEvidencePath.Manifest
        ),
        manifest = readVerifierJson(
          fixture.runDirectory,
          RunEvidencePath.Manifest
        )
      Fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

      // When: exact serializer bytes are checked.
      const report = verifyRunEvidence(fixture.runDirectory)

      // Then: canonical representation is part of schema-v1 integrity.
      expect(report.issues.map(issue => issue.code)).toContain(
        RunEvidenceVerificationIssueCode.NonCanonicalJson
      )
    } finally {
      fixture.cleanup()
    }
  })
})
